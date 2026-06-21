import {
    Client,
    clearClientSpawnFallbackTimer,
    clearKeepTutorialTimers,
    createKeepTutorialState,
    KeepTutorialState
} from '../core/Client';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { LevelConfig } from '../core/LevelConfig';
import { GlobalState, PendingTransfer } from '../core/GlobalState';
import { DebugLogger } from '../core/Debug';
import {
    cloneDungeonRunStats,
    finalizeDungeonRun,
    noteDungeonRunBossCutscene,
    noteDungeonRunCompletionProgress,
    noteDungeonRunEntitySeen
} from '../core/DungeonRunStats';
import { clearStoredDungeonSnapshot } from '../core/DungeonSnapshot';
import { DungeonEntryDisplay } from '../core/DungeonEntryDisplay';
import { WorldEnter } from '../utils/WorldEnter';
import { Config } from '../core/config';
import { MissionLoader } from '../data/MissionLoader';
import { NpcLoader, NpcDef } from '../data/NpcLoader';
import { DialogueTranslationLoader } from '../data/DialogueTranslationLoader';
import { MissionID } from '../data/runtime';
import { Entity, EntityState, EntityTeam } from '../core/Entity';
import { Character } from '../database/Database';
import { EntityHandler } from './EntityHandler';
import { MissionHandler } from './MissionHandler';
import { PetHandler } from './PetHandler';
import { JsonAdapter } from '../database/JsonAdapter';
import { normalizeCharacterKey, PendingTeleport } from '../core/SocialState';
import { TransferTokenAllocator } from '../core/TransferTokenAllocator';
import { areClientsInSameParty, getPartyIdForClient, sharesRoomIds } from '../core/PartySync';
import { syncPotionReservationForLevelTransition } from '../utils/ConsumableState';
import {
    getSharedDungeonInitialProgress,
    getOrCreateSharedDungeonProgressState,
    getSharedDungeonProgressState,
    getSharedDungeonProgressTotals,
    hasSharedDungeonProgressHostiles,
    recomputeSharedDungeonProgress,
    resolveSharedDungeonProgressAuthorityToken,
    usesSharedDungeonProgress
} from '../core/SharedDungeonProgress';
import {
    areClientsInSameLevelScope,
    createDungeonInstanceId,
    getClientLevelScope,
    getLevelScopeKey,
    normalizeLevelInstanceId
} from '../core/LevelScope';
import { markRoomBossEntity } from '../core/RoomBossState';
import { getCharacterRuntimeLevel, getPartyRuntimeLevelForClient } from '../core/RuntimeLevel';
import { getCraftTownHomeInstanceId } from '../utils/HomeVisitGuard';

const db = new JsonAdapter();

type LevelSyncState = {
    x: number;
    y: number;
    hasCoord: boolean;
    playSessionStartedAt?: number;
    levelInstanceId?: string;
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
};

type DoorTravelContext = {
    sourceLevel: string;
    sourceDoorId: number;
    targetLevel: string;
};

type TransferSyncAnchorCandidate = {
    source: 'active' | 'pending';
    token?: number;
    characterKey: string;
    state: LevelSyncState;
};

type LevelTriggerSpec = {
    roomId: number;
    triggerName: string;
    triggerX: number;
    triggerMinY: number;
    triggerMaxY: number;
};

type DeferredMissionWork = () => Promise<void>;

type MissionWorkExecutorClient = Client & { socket?: unknown };

export class LevelHandler {

    private static deferMissionWork(client: Client, label: string, work: DeferredMissionWork): void {
        const executeWork = (): void => {
            void work().catch((error) => {
                console.error(`[LevelHandler] Error processing ${label}:`, error);
            });
        };

        const hasLiveSocket = Boolean(
            (client as MissionWorkExecutorClient).socket && (client as Client & { socket: { write?: unknown } }).socket.write
        );

        if (hasLiveSocket) {
            setImmediate(executeWork);
            return;
        }

        executeWork();
    }

    private static readonly DOORSTATE_CLOSED = 0;
    private static readonly DOORSTATE_STATIC = 1;
    private static readonly DOORSTATE_DUNGEON = 2;
    private static readonly DOORSTATE_MISSIONREPEAT = 3;
    private static readonly DOORSTATE_LOCKED = 4;
    private static readonly DREADFOLD_GATE_LOCKED_MESSAGE =
        '^tA powerful magic seals this entrance.=^tI still need to learn more about the Sleeping Lands.';
    private static readonly LOCKED_DUNGEON_ENTRY_MESSAGE = "^tI haven't unlocked this dungeon yet.";
    private static readonly LOCKED_STORY_AREA_ENTRY_MESSAGE = "^tI haven't unlocked this area yet.";
    private static readonly CASTLE_HOCKE_GATE_DOOR_ID = 3;
    private static readonly VALHAVEN_GATE_DOOR_ID = 2;
    private static readonly GOBLIN_RIVER_INITIAL_PROGRESS = 11;
    private static readonly TUTORIAL_DUNGEON_INITIAL_PROGRESS = 11;
    private static readonly KEEP_TUTORIAL_HELPER_RESPAWN_DELAY_MS = 1200;
    private static readonly DEEPGARD_DRAGON_MINIBOSS_ROOM_ID = 2003367144;
    private static readonly DEEPGARD_DRAGON_MINIBOSS_TRIGGER_X = -2560;
    private static readonly DEEPGARD_DRAGON_MINIBOSS_TRIGGER_MIN_Y = -3100;
    private static readonly DEEPGARD_DRAGON_MINIBOSS_TRIGGER_MAX_Y = -1750;
    private static readonly BACK_ALLEY_DEALS_BOSS_ROOM_ID = 2553897284;
    private static readonly BACK_ALLEY_DEALS_BOSS_TRIGGER_X = 25480;
    private static readonly BACK_ALLEY_DEALS_BOSS_TRIGGER_MIN_Y = 2550;
    private static readonly BACK_ALLEY_DEALS_BOSS_TRIGGER_MAX_Y = 3400;
    private static readonly PRODIGAL_SON_DEFECTOR_TRIGGERS: readonly LevelTriggerSpec[] = [
        {
            roomId: 1971923064,
            triggerName: 'am_Trigger_01',
            triggerX: 9840,
            triggerMinY: -1790,
            triggerMaxY: -1090
        },
        {
            roomId: 2061059764,
            triggerName: 'am_Trigger_01',
            triggerX: 18240,
            triggerMinY: -1550,
            triggerMaxY: -750
        }
    ];
    private static craftTownTutorialHelperIdsCache: number[] | null = null;
    private static readonly GOBLIN_RIVER_BOSS_INTRO_TEXTS = new Set<string>([
        "You're the one that killed our Kraken!",
        'That was the last of our Monster Fleet!'
    ]);
    private static readonly GOBLIN_RIVER_BOSS_INTRO_DEFAULT_MS = 5000;
    private static readonly DUNGEON_CUTSCENE_COMBAT_LOCK_MAX_MS = 30000;

    private static resolveDungeonMapPacketLevel(
        levelName: string,
        configuredLevel: number,
        character: Character,
        client?: Client
    ): number {
        if (!LevelConfig.isDungeonLevel(levelName)) {
            return configuredLevel;
        }

        return client
            ? getPartyRuntimeLevelForClient(client, character, configuredLevel)
            : getCharacterRuntimeLevel(character, configuredLevel);
    }

    private static getCraftTownTutorialAuthoredHelperIds(): number[] {
        if (LevelHandler.craftTownTutorialHelperIdsCache) {
            return [...LevelHandler.craftTownTutorialHelperIdsCache];
        }

        const helperIds = NpcLoader.getRawNpcsForLevel('CraftTownTutorial')
            .filter((npc) =>
                String(npc?.name ?? '') === 'GoblinDagger' &&
                String(npc?.DramaAnim ?? '') === 'Board' &&
                Number(npc?.team ?? 0) === EntityTeam.ENEMY
            )
            .sort((left, right) => Number(left?.x ?? 0) - Number(right?.x ?? 0))
            .map((npc) => Number(npc.id ?? 0))
            .filter((id) => id > 0);

        LevelHandler.craftTownTutorialHelperIdsCache = helperIds;
        return [...helperIds];
    }

    private static resolveTransferSourceLevel(client: Client, character: any): string {
        // Keep-clear flows intentionally preserve the safe return point in Character.CurrentLevel
        // until the actual exit transfer runs, so the live session level must win here.
        return LevelConfig.normalizeLevelName(
            client.currentLevel || character?.CurrentLevel?.name || 'NewbieRoad'
        ) || 'NewbieRoad';
    }

    private static resolveCraftTownReturnLevel(
        client: Client,
        character: any,
        oldLevel: string,
        syncState: LevelSyncState | null
    ): string {
        return LevelConfig.resolveSafeReturnLevel(
            [
                syncState?.syncEntryLevel,
                client.entryLevel,
                character?.PreviousLevel?.name,
                oldLevel,
                character?.CurrentLevel?.name
            ],
            {
                fallbackLevel: 'NewbieRoad',
                excludedLevels: ['CraftTown', 'CraftTownTutorial']
            }
        );
    }

    private static syncTransferSourcePositionFromLiveEntity(
        character: any,
        sourceLevel: string,
        entity: { x?: number; y?: number } | null | undefined
    ): void {
        const normalizedSourceLevel = LevelConfig.normalizeLevelName(sourceLevel);
        if (!character || !normalizedSourceLevel || LevelConfig.isDungeonLevel(normalizedSourceLevel)) {
            return;
        }

        const liveX = Number(entity?.x);
        const liveY = Number(entity?.y);
        if (!Number.isFinite(liveX) || !Number.isFinite(liveY)) {
            return;
        }

        character.CurrentLevel = {
            name: normalizedSourceLevel,
            x: Math.round(liveX),
            y: Math.round(liveY)
        };
    }

    private static cloneTransferGameplayState(target: Client, source: Client): void {
        target.character = source.character;
        target.craftTownHostCharacter = source.craftTownHostCharacter;
        target.userId = source.userId;
        target.characters = Array.isArray(source.characters) ? [...source.characters] : [];
        target.currentLevel = source.currentLevel;
        target.levelInstanceId = source.levelInstanceId;
        target.entryLevel = source.entryLevel;
        target.entryX = source.entryX;
        target.entryY = source.entryY;
        target.entryHasCoord = source.entryHasCoord;
        target.currentRoomId = source.currentRoomId;
        target.lastDoorId = source.lastDoorId;
        target.lastDoorTargetLevel = source.lastDoorTargetLevel;
        target.playSessionStartedAt = Number.isFinite(source.playSessionStartedAt) && source.playSessionStartedAt > 0
            ? Math.round(source.playSessionStartedAt)
            : Date.now();
        target.clientEntID = source.clientEntID;
        target.token = source.token;
        target.playerSpawned = source.playerSpawned;
        target.syncAnchorStartedAt = LevelHandler.normalizeSyncAnchorStartedAt(source.syncAnchorStartedAt) ?? 0;
        target.syncAnchorToken = Number(source.syncAnchorToken ?? 0) > 0 ? Math.round(Number(source.syncAnchorToken)) : 0;
        target.syncAnchorCharacterName = String(source.syncAnchorCharacterName ?? '').trim();
        target.syncQuestProgress = LevelHandler.normalizeQuestProgress(source.syncQuestProgress ?? source.character?.questTrackerState);
        target.entities = new Map(source.entities);
        target.startedRoomEvents = new Set(source.startedRoomEvents);
        target.triggeredLevelStates = new Set(source.triggeredLevelStates);
        target.dungeonRun = cloneDungeonRunStats(source.dungeonRun);
    }

    private static getActiveDoorTravelContext(
        client: Pick<Client, 'currentLevel' | 'lastDoorId' | 'lastDoorTargetLevel'>,
        targetLevelName: string | null | undefined
    ): DoorTravelContext | null {
        const sourceLevel = LevelConfig.normalizeLevelName(client.currentLevel);
        const targetLevel = LevelConfig.normalizeLevelName(targetLevelName);
        const lastDoorTarget = LevelConfig.normalizeLevelName(client.lastDoorTargetLevel);
        const sourceDoorId = Number(client.lastDoorId);

        if (
            !sourceLevel ||
            !targetLevel ||
            lastDoorTarget !== targetLevel ||
            !Number.isFinite(sourceDoorId) ||
            sourceDoorId < 0
        ) {
            return null;
        }

        return {
            sourceLevel,
            sourceDoorId: Math.round(sourceDoorId),
            targetLevel
        };
    }

    private static findActiveTransferSession(userId: number | null, characterName: string | null | undefined): Client | null {
        const normalizedCharName = normalizeCharacterKey(characterName);

        if (normalizedCharName) {
            const charSession = GlobalState.sessionsByCharacterName.get(normalizedCharName);
            if (charSession?.character && (!userId || charSession.userId === userId)) {
                return charSession;
            }

            for (const session of GlobalState.sessionsByToken.values()) {
                if (!session.character || (userId && session.userId !== userId)) {
                    continue;
                }
                if (normalizeCharacterKey(session.character.name) === normalizedCharName) {
                    return session;
                }
            }

            return null;
        }

        if (userId) {
            return GlobalState.getActiveSessionsByUserId(userId)[0] ?? null;
        }

        return null;
    }

    private static normalizeStartedRoomIds(levelName: string, startedRoomIds: number[] | null | undefined): number[] {
        const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
        if (!normalizedLevel || !Array.isArray(startedRoomIds)) {
            return [];
        }

        const deduped = new Set<number>();
        for (const roomId of startedRoomIds) {
            const numericRoomId = Number(roomId);
            if (!Number.isFinite(numericRoomId) || numericRoomId < 0) {
                continue;
            }
            deduped.add(Math.round(numericRoomId));
        }

        return Array.from(deduped.values()).sort((left, right) => left - right);
    }

    private static getStartedRoomIdsForLevel(session: Client, levelName: string): number[] {
        const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
        if (!normalizedLevel) {
            return [];
        }

        const startedRoomIds = new Set<number>();
        for (const key of session.startedRoomEvents) {
            const separatorIndex = key.lastIndexOf(':');
            if (separatorIndex <= 0) {
                continue;
            }

            const eventLevel = LevelConfig.normalizeLevelName(key.substring(0, separatorIndex));
            if (eventLevel !== normalizedLevel) {
                continue;
            }

            const roomId = Number(key.substring(separatorIndex + 1));
            if (Number.isFinite(roomId) && roomId >= 0) {
                startedRoomIds.add(Math.round(roomId));
            }
        }

        return Array.from(startedRoomIds.values()).sort((left, right) => left - right);
    }

    private static normalizeSyncAnchorStartedAt(value: unknown): number | undefined {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue) || numericValue <= 0) {
            return undefined;
        }

        return Math.round(numericValue);
    }

    private static buildActiveTransferSyncAnchorCandidate(
        session: Client,
        targetLevel: string
    ): TransferSyncAnchorCandidate | null {
        if (
            !session.playerSpawned ||
            !session.character ||
            LevelConfig.normalizeLevelName(session.currentLevel) !== targetLevel
        ) {
            return null;
        }

        let x = 0;
        let y = 0;
        let hasCoord = false;
        const entity = session.entities.get(session.clientEntID);
        if (entity && Number.isFinite(entity.x) && Number.isFinite(entity.y)) {
            x = Math.round(Number(entity.x));
            y = Math.round(Number(entity.y));
            hasCoord = true;
        } else {
            const savedLevel = session.character.CurrentLevel;
            if (
                LevelConfig.normalizeLevelName(savedLevel?.name) === targetLevel &&
                Number.isFinite(savedLevel?.x) &&
                Number.isFinite(savedLevel?.y)
            ) {
                x = Math.round(Number(savedLevel.x));
                y = Math.round(Number(savedLevel.y));
                hasCoord = true;
            }
        }

        const startedRoomIds = LevelHandler.getStartedRoomIdsForLevel(session, targetLevel);
        return {
            source: 'active',
            token: session.token > 0 ? session.token : undefined,
            characterKey: normalizeCharacterKey(session.character.name),
            state: {
                x,
                y,
                hasCoord,
                levelInstanceId: normalizeLevelInstanceId(session.levelInstanceId) || undefined,
                syncAnchorStartedAt: LevelHandler.normalizeSyncAnchorStartedAt(session.syncAnchorStartedAt),
                syncAnchorToken: Number(session.syncAnchorToken ?? 0) > 0
                    ? Math.round(Number(session.syncAnchorToken))
                    : (session.token > 0 ? session.token : undefined),
                syncAnchorCharacterName: String(session.syncAnchorCharacterName ?? session.character.name).trim() || undefined,
                syncEntryLevel: LevelConfig.normalizeLevelName(session.entryLevel) || undefined,
                syncEntryX: session.entryHasCoord ? Math.round(Number(session.entryX ?? 0)) : undefined,
                syncEntryY: session.entryHasCoord ? Math.round(Number(session.entryY ?? 0)) : undefined,
                syncEntryHasCoord: Boolean(session.entryHasCoord),
                syncRoomId: Number.isFinite(Number(session.currentRoomId)) && session.currentRoomId >= 0
                    ? Math.round(Number(session.currentRoomId))
                    : undefined,
                syncStartedRoomIds: startedRoomIds,
                syncQuestProgress: LevelHandler.normalizeQuestProgress(session.character.questTrackerState)
            }
        };
    }

    private static buildPendingTransferSyncAnchorCandidate(
        token: number,
        entry: PendingTransfer,
        targetLevel: string
    ): TransferSyncAnchorCandidate | null {
        if (
            !entry.character ||
            LevelConfig.normalizeLevelName(entry.targetLevel) !== targetLevel
        ) {
            return null;
        }

        const newX = Number(entry.newX ?? 0);
        const newY = Number(entry.newY ?? 0);
        const hasCoord = Boolean(entry.newHasCoord) && Number.isFinite(newX) && Number.isFinite(newY);
        return {
            source: 'pending',
            token: token > 0 ? token : undefined,
            characterKey: normalizeCharacterKey(entry.character.name),
            state: {
                x: hasCoord ? Math.round(newX) : 0,
                y: hasCoord ? Math.round(newY) : 0,
                hasCoord,
                levelInstanceId: normalizeLevelInstanceId(entry.levelInstanceId) || undefined,
                syncAnchorStartedAt: LevelHandler.normalizeSyncAnchorStartedAt(entry.syncAnchorStartedAt),
                syncAnchorToken: Number(entry.syncAnchorToken ?? 0) > 0
                    ? Math.round(Number(entry.syncAnchorToken))
                    : (token > 0 ? token : undefined),
                syncAnchorCharacterName: String(entry.syncAnchorCharacterName ?? entry.character.name).trim() || undefined,
                syncEntryLevel: LevelConfig.normalizeLevelName(entry.syncEntryLevel ?? entry.previousLevel) || undefined,
                syncEntryX: entry.syncEntryHasCoord ? Math.round(Number(entry.syncEntryX ?? 0)) : undefined,
                syncEntryY: entry.syncEntryHasCoord ? Math.round(Number(entry.syncEntryY ?? 0)) : undefined,
                syncEntryHasCoord: Boolean(entry.syncEntryHasCoord),
                syncRoomId: Number.isFinite(Number(entry.syncRoomId)) && Number(entry.syncRoomId) >= 0
                    ? Math.round(Number(entry.syncRoomId))
                    : undefined,
                syncStartedRoomIds: LevelHandler.normalizeStartedRoomIds(targetLevel, entry.syncStartedRoomIds),
                syncQuestProgress: LevelHandler.normalizeQuestProgress(entry.syncQuestProgress)
            }
        };
    }

    private static compareTransferSyncAnchorCandidates(
        left: TransferSyncAnchorCandidate,
        right: TransferSyncAnchorCandidate
    ): number {
        const leftStartedAt = LevelHandler.normalizeSyncAnchorStartedAt(left.state.syncAnchorStartedAt) ?? Number.MAX_SAFE_INTEGER;
        const rightStartedAt = LevelHandler.normalizeSyncAnchorStartedAt(right.state.syncAnchorStartedAt) ?? Number.MAX_SAFE_INTEGER;
        if (leftStartedAt !== rightStartedAt) {
            return leftStartedAt - rightStartedAt;
        }

        const leftIsRootAuthority = Boolean(left.token && left.state.syncAnchorToken && left.token === left.state.syncAnchorToken);
        const rightIsRootAuthority = Boolean(right.token && right.state.syncAnchorToken && right.token === right.state.syncAnchorToken);
        if (leftIsRootAuthority !== rightIsRootAuthority) {
            return leftIsRootAuthority ? -1 : 1;
        }

        if (left.source !== right.source) {
            return left.source === 'active' ? -1 : 1;
        }

        const leftToken = left.token ?? Number.MAX_SAFE_INTEGER;
        const rightToken = right.token ?? Number.MAX_SAFE_INTEGER;
        if (leftToken !== rightToken) {
            return leftToken - rightToken;
        }

        return left.characterKey.localeCompare(right.characterKey);
    }

    private static resolveExplicitSyncAnchor(
        targetLevel: string,
        teleportOverride: PendingTeleport | null
    ): TransferSyncAnchorCandidate | null {
        if (!teleportOverride) {
            return null;
        }

        const desiredLevel = LevelConfig.normalizeLevelName(targetLevel);
        if (!desiredLevel) {
            return null;
        }

        const explicitToken = Number(teleportOverride.syncAnchorToken ?? 0) > 0
            ? Math.round(Number(teleportOverride.syncAnchorToken))
            : 0;
        const explicitNameKey = normalizeCharacterKey(teleportOverride.syncAnchorCharacterName);
        if (!explicitToken && !explicitNameKey) {
            return null;
        }

        let bestCandidate: TransferSyncAnchorCandidate | null = null;

        for (const session of GlobalState.sessionsByToken.values()) {
            const candidate = LevelHandler.buildActiveTransferSyncAnchorCandidate(session, desiredLevel);
            if (!candidate) {
                continue;
            }
            if (explicitToken && candidate.token === explicitToken) {
                return candidate;
            }
            if (explicitNameKey && candidate.characterKey === explicitNameKey) {
                bestCandidate = bestCandidate && LevelHandler.compareTransferSyncAnchorCandidates(bestCandidate, candidate) <= 0
                    ? bestCandidate
                    : candidate;
            }
        }

        for (const [token, entry] of GlobalState.pendingWorld.entries()) {
            const candidate = LevelHandler.buildPendingTransferSyncAnchorCandidate(token, entry, desiredLevel);
            if (!candidate) {
                continue;
            }
            if (explicitToken && candidate.token === explicitToken) {
                return candidate;
            }
            if (explicitNameKey && candidate.characterKey === explicitNameKey) {
                bestCandidate = bestCandidate && LevelHandler.compareTransferSyncAnchorCandidates(bestCandidate, candidate) <= 0
                    ? bestCandidate
                    : candidate;
            }
        }

        return bestCandidate;
    }

    private static collectPartyTransferSyncAnchorCandidates(
        client: Client,
        targetLevel: string
    ): TransferSyncAnchorCandidate[] {
        const partyId = getPartyIdForClient(client);
        if (partyId <= 0) {
            return [];
        }

        const ownCharacterKey = normalizeCharacterKey(client.character?.name);
        const candidates: TransferSyncAnchorCandidate[] = [];

        for (const other of GlobalState.sessionsByToken.values()) {
            if (other === client || !areClientsInSameParty(client, other)) {
                continue;
            }

            const candidate = LevelHandler.buildActiveTransferSyncAnchorCandidate(other, targetLevel);
            if (!candidate || candidate.characterKey === ownCharacterKey) {
                continue;
            }

            candidates.push(candidate);
        }

        for (const [token, entry] of GlobalState.pendingWorld.entries()) {
            const candidate = LevelHandler.buildPendingTransferSyncAnchorCandidate(token, entry, targetLevel);
            if (!candidate || candidate.characterKey === ownCharacterKey) {
                continue;
            }

            if (Number(GlobalState.partyByMember.get(candidate.characterKey) ?? 0) !== partyId) {
                continue;
            }

            candidates.push(candidate);
        }

        candidates.sort((left, right) => LevelHandler.compareTransferSyncAnchorCandidates(left, right));
        return candidates;
    }

    private static resolveTransferSyncAnchor(
        client: Client,
        targetLevel: string,
        teleportOverride: PendingTeleport | null
    ): TransferSyncAnchorCandidate | null {
        const explicitAnchor = LevelHandler.resolveExplicitSyncAnchor(targetLevel, teleportOverride);
        if (explicitAnchor && explicitAnchor.characterKey !== normalizeCharacterKey(client.character?.name)) {
            return explicitAnchor;
        }

        if (!LevelConfig.isDungeonLevel(targetLevel)) {
            return null;
        }

        return LevelHandler.collectPartyTransferSyncAnchorCandidates(client, targetLevel)[0] ?? null;
    }

    private static applyStoredRoomProgressState(
        client: Client,
        levelName: string,
        syncRoomId?: number,
        syncStartedRoomIds?: number[],
        replayPackets: boolean = false
    ): boolean {
        const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
        if (!normalizedLevel) {
            return false;
        }
        if (LevelHandler.shouldSkipDungeonRoomProgressSync(normalizedLevel)) {
            return false;
        }

        const startedRoomIds = LevelHandler.normalizeStartedRoomIds(normalizedLevel, syncStartedRoomIds);
        const roomId = Number.isFinite(Number(syncRoomId)) && Number(syncRoomId) >= 0
            ? Math.round(Number(syncRoomId))
            : -1;
        const didApplyState = roomId >= 0 || startedRoomIds.length > 0;

        if (roomId >= 0 && !startedRoomIds.includes(roomId)) {
            startedRoomIds.push(roomId);
            startedRoomIds.sort((left, right) => left - right);
        }

        if (roomId >= 0) {
            client.currentRoomId = roomId;
        }

        for (const startedRoomId of startedRoomIds) {
            client.startedRoomEvents.add(`${normalizedLevel}:${startedRoomId}`);
        }

        if (!replayPackets) {
            return didApplyState;
        }

        for (const startedRoomId of startedRoomIds) {
            if (!LevelHandler.hasRoomEventStarted(client, startedRoomId)) {
                LevelHandler.sendRoomEventStart(client, startedRoomId, true);
            } else {
                const bb = new BitBuffer(false);
                bb.writeMethod9(startedRoomId);
                bb.writeMethod15(true);
                client.sendBitBuffer(0xA5, bb);
            }
        }

        return didApplyState;
    }

    private static buildTransferSyncState(
        client: Client,
        targetLevel: string,
        teleportOverride: PendingTeleport | null
    ): LevelSyncState | null {
        const normalizedTargetLevel = LevelConfig.normalizeLevelName(targetLevel);
        if (!normalizedTargetLevel) {
            return null;
        }

        const shouldSyncDungeonProgress = LevelConfig.isDungeonLevel(normalizedTargetLevel);
        const anchor = LevelHandler.resolveTransferSyncAnchor(client, normalizedTargetLevel, teleportOverride);
        const shouldUseAnchorEntryReturn = !teleportOverride;
        let x = Math.round(Number(teleportOverride?.x ?? 0));
        let y = Math.round(Number(teleportOverride?.y ?? 0));
        let hasCoord = Boolean(teleportOverride?.hasCoord);
        let levelInstanceId = shouldSyncDungeonProgress
            ? normalizeLevelInstanceId(teleportOverride?.levelInstanceId)
            : '';
        let syncAnchorStartedAt = shouldSyncDungeonProgress
            ? LevelHandler.normalizeSyncAnchorStartedAt(client.syncAnchorStartedAt)
            : undefined;
        let syncEntryLevel = shouldSyncDungeonProgress
            ? (
                LevelConfig.normalizeLevelName(client.entryLevel) ||
                (
                    !LevelConfig.isDungeonLevel(client.currentLevel)
                        ? LevelConfig.normalizeLevelName(client.currentLevel)
                        : ''
                ) ||
                undefined
            )
            : undefined;
        let syncEntryX: number | undefined;
        let syncEntryY: number | undefined;
        let syncEntryHasCoord = false;
        let syncRoomId = shouldSyncDungeonProgress &&
            Number.isFinite(Number(teleportOverride?.syncRoomId)) &&
            Number(teleportOverride?.syncRoomId) >= 0
            ? Math.round(Number(teleportOverride?.syncRoomId))
            : undefined;
        let syncStartedRoomIds = shouldSyncDungeonProgress
            ? LevelHandler.normalizeStartedRoomIds(normalizedTargetLevel, teleportOverride?.syncStartedRoomIds)
            : [];
        let syncQuestProgress = shouldSyncDungeonProgress
            ? LevelHandler.normalizeQuestProgress((teleportOverride as PendingTeleport & { syncQuestProgress?: number } | null)?.syncQuestProgress)
            : undefined;
        const fallbackSyncAnchorToken = shouldSyncDungeonProgress ? client.syncAnchorToken : 0;
        let syncAnchorToken = Number(teleportOverride?.syncAnchorToken ?? fallbackSyncAnchorToken ?? 0) > 0
            ? Math.round(Number(teleportOverride?.syncAnchorToken ?? fallbackSyncAnchorToken ?? 0))
            : undefined;
        let syncAnchorCharacterName = String(
            teleportOverride?.syncAnchorCharacterName ??
            (shouldSyncDungeonProgress ? client.syncAnchorCharacterName : '') ??
            ''
        ).trim() || undefined;

        if (anchor) {
            const anchorState = anchor.state;
            if (!shouldSyncDungeonProgress && anchorState.hasCoord) {
                x = Math.round(Number(anchorState.x ?? 0));
                y = Math.round(Number(anchorState.y ?? 0));
                hasCoord = true;
            }

            syncAnchorToken = anchorState.syncAnchorToken ?? syncAnchorToken;
            syncAnchorCharacterName = anchorState.syncAnchorCharacterName ?? syncAnchorCharacterName;
            if (shouldSyncDungeonProgress) {
                levelInstanceId = normalizeLevelInstanceId(anchorState.levelInstanceId) || levelInstanceId;
                syncAnchorStartedAt = LevelHandler.normalizeSyncAnchorStartedAt(anchorState.syncAnchorStartedAt) ?? syncAnchorStartedAt;
                if (shouldUseAnchorEntryReturn) {
                    syncEntryLevel = LevelConfig.normalizeLevelName(anchorState.syncEntryLevel) || syncEntryLevel;
                }
                if (
                    shouldUseAnchorEntryReturn &&
                    anchorState.syncEntryHasCoord &&
                    Number.isFinite(Number(anchorState.syncEntryX)) &&
                    Number.isFinite(Number(anchorState.syncEntryY))
                ) {
                    syncEntryX = Math.round(Number(anchorState.syncEntryX));
                    syncEntryY = Math.round(Number(anchorState.syncEntryY));
                    syncEntryHasCoord = true;
                }
                if (Number.isFinite(Number(anchorState.syncRoomId)) && Number(anchorState.syncRoomId) >= 0) {
                    syncRoomId = Math.round(Number(anchorState.syncRoomId));
                }
                const anchorStartedRoomIds = LevelHandler.normalizeStartedRoomIds(
                    normalizedTargetLevel,
                    anchorState.syncStartedRoomIds
                );
                if (anchorStartedRoomIds.length > 0) {
                    syncStartedRoomIds = anchorStartedRoomIds;
                }
                syncQuestProgress = LevelHandler.normalizeQuestProgress(anchorState.syncQuestProgress) ?? syncQuestProgress;
            }
        }

        if (shouldSyncDungeonProgress) {
            syncAnchorStartedAt = syncAnchorStartedAt ?? Date.now();
            const entryEntity = client.clientEntID > 0 ? client.entities.get(client.clientEntID) : null;
            const sourceLevel = LevelConfig.normalizeLevelName(client.currentLevel);
            if (
                !syncEntryHasCoord &&
                syncEntryLevel &&
                sourceLevel === syncEntryLevel &&
                !LevelConfig.isDungeonLevel(sourceLevel) &&
                Number.isFinite(Number(entryEntity?.x)) &&
                Number.isFinite(Number(entryEntity?.y))
            ) {
                syncEntryX = Math.round(Number(entryEntity.x));
                syncEntryY = Math.round(Number(entryEntity.y));
                syncEntryHasCoord = true;
            }
            const dungeonEntrySpawnOverride =
                !anchor &&
                !levelInstanceId &&
                syncRoomId === undefined &&
                syncStartedRoomIds.length === 0
                    ? LevelConfig.getDungeonEntrySpawnOverride(normalizedTargetLevel)
                    : null;
            if (dungeonEntrySpawnOverride) {
                x = Math.round(dungeonEntrySpawnOverride.x);
                y = Math.round(dungeonEntrySpawnOverride.y);
                hasCoord = true;
            } else {
                // Dungeon start position is authored by the dungeon SWF unless a known level has broken spawn markers.
                hasCoord = false;
            }
        }

        if (
            !shouldSyncDungeonProgress &&
            !hasCoord &&
            !levelInstanceId &&
            !syncStartedRoomIds.length &&
            syncRoomId === undefined &&
            !syncEntryLevel
        ) {
            return null;
        }

        return {
            x,
            y,
            hasCoord,
            playSessionStartedAt: Number.isFinite(client.playSessionStartedAt) && client.playSessionStartedAt > 0
                ? Math.round(client.playSessionStartedAt)
                : Date.now(),
            levelInstanceId: levelInstanceId || undefined,
            syncAnchorStartedAt,
            syncAnchorToken,
            syncAnchorCharacterName,
            syncEntryLevel,
            syncEntryX,
            syncEntryY,
            syncEntryHasCoord,
            syncRoomId,
            syncStartedRoomIds,
            syncQuestProgress
        };
    }

    private static resolveDungeonExitSpawn(
        client: Client,
        activeCharacter: any,
        oldLevel: string,
        targetLevel: string,
        syncState: LevelSyncState | null
    ): { x: number; y: number; hasCoord: boolean } {
        if (syncState?.hasCoord) {
            return {
                x: Math.round(Number(syncState.x ?? 0)),
                y: Math.round(Number(syncState.y ?? 0)),
                hasCoord: true
            };
        }

        const normalizedOldLevel = LevelConfig.normalizeLevelName(oldLevel);
        const normalizedTargetLevel = LevelConfig.normalizeLevelName(targetLevel);
        const normalizedEntryLevel = LevelConfig.normalizeLevelName(client.entryLevel);
        if (
            normalizedOldLevel &&
            normalizedTargetLevel &&
            LevelConfig.isDungeonLevel(normalizedOldLevel) &&
            normalizedTargetLevel === normalizedEntryLevel &&
            client.entryHasCoord &&
            Number.isFinite(Number(client.entryX)) &&
            Number.isFinite(Number(client.entryY))
        ) {
            return {
                x: Math.round(Number(client.entryX)),
                y: Math.round(Number(client.entryY)),
                hasCoord: true
            };
        }

        const activeDoorId = (
            LevelConfig.normalizeLevelName(client.lastDoorTargetLevel) === normalizedTargetLevel
        )
            ? client.lastDoorId
            : null;
        return LevelConfig.getSpawnCoordinates(activeCharacter, oldLevel, targetLevel, activeDoorId);
    }

    private static readonly CLIENT_SPAWN_FALLBACK_MS = 5000;
    private static readonly FIRST_KEEP_MISSION_ID = MissionID.ClearYourHouse;
    private static readonly MISSION_NOT_STARTED = 0;
    private static readonly MISSION_IN_PROGRESS = 1;
    private static readonly MISSION_READY_TO_TURN_IN = 2;
    private static readonly MISSION_CLAIMED = 3;
    private static readonly DREADFOLD_GATE_DOOR_ID = 300;
    private static readonly DREADFOLD_ENTRY_TRANSITIONS = new Set<string>([
        'BridgeTown->BridgeTownHard',
        'EmeraldGlades->EmeraldGladesHard',
        'ShazariDesert->ShazariDesertHard',
        'JadeCity->JadeCityHard'
    ]);
    private static readonly STORY_AREA_ENTRY_REQUIREMENTS = new Map<string, number>([
        ['Castle->ShazariDesert', MissionID.IntoTheDepths],
        ['CastleHard->ShazariDesertHard', MissionID.IntoTheDepthsHard],
        ['BridgeTownHard->CemeteryHillHard', MissionID.OldHeroesNeverDieHard],
        ['BridgeTownHard->OldMineMountainHard', MissionID.DerelictionOfDutyHard]
    ]);
    private static readonly STORY_AREA_ENTRY_MIN_STATES = new Map<string, number>([
        ['Castle->ShazariDesert', LevelHandler.MISSION_IN_PROGRESS],
        ['CastleHard->ShazariDesertHard', LevelHandler.MISSION_IN_PROGRESS]
    ]);
    private static readonly FAST_TRAVEL_AREA_REQUIREMENTS = new Map<
        string,
        Array<{ missionId: number; minState: number }>
    >([
        ['NewbieRoad', []],
        ['SwampRoadNorth', []],
        ['BridgeTown', [{ missionId: MissionID.ClearTheBridge, minState: LevelHandler.MISSION_READY_TO_TURN_IN }]],
        ['CemeteryHill', [{ missionId: MissionID.ClearTheBridge, minState: LevelHandler.MISSION_READY_TO_TURN_IN }]],
        ['OldMineMountain', [{ missionId: MissionID.ClearTheBridge, minState: LevelHandler.MISSION_READY_TO_TURN_IN }]],
        ['EmeraldGlades', [{ missionId: MissionID.ClearTheBridge, minState: LevelHandler.MISSION_READY_TO_TURN_IN }]],
        ['Castle', [{ missionId: MissionID.DeepgardDragon, minState: LevelHandler.MISSION_READY_TO_TURN_IN }]],
        ['ShazariDesert', [{ missionId: MissionID.IntoTheDepths, minState: LevelHandler.MISSION_IN_PROGRESS }]],
        ['JadeCity', [{ missionId: MissionID.HeadToValhaven, minState: LevelHandler.MISSION_READY_TO_TURN_IN }]],
        ['NewbieRoadHard', [{ missionId: MissionID.Capstone, minState: LevelHandler.MISSION_CLAIMED }]],
        ['SwampRoadNorthHard', [{ missionId: MissionID.Capstone, minState: LevelHandler.MISSION_CLAIMED }]],
        ['BridgeTownHard', [{ missionId: MissionID.Capstone, minState: LevelHandler.MISSION_CLAIMED }]],
        ['CemeteryHillHard', [
            { missionId: MissionID.Capstone, minState: LevelHandler.MISSION_CLAIMED },
            { missionId: MissionID.OldHeroesNeverDieHard, minState: LevelHandler.MISSION_CLAIMED }
        ]],
        ['OldMineMountainHard', [
            { missionId: MissionID.Capstone, minState: LevelHandler.MISSION_CLAIMED },
            { missionId: MissionID.DerelictionOfDutyHard, minState: LevelHandler.MISSION_CLAIMED }
        ]],
        ['EmeraldGladesHard', [
            { missionId: MissionID.Capstone, minState: LevelHandler.MISSION_CLAIMED },
            { missionId: MissionID.DerelictionOfDutyHard, minState: LevelHandler.MISSION_CLAIMED }
        ]],
        ['CastleHard', [
            { missionId: MissionID.Capstone, minState: LevelHandler.MISSION_CLAIMED },
            { missionId: MissionID.DeepgardDragonHard, minState: LevelHandler.MISSION_READY_TO_TURN_IN }
        ]],
        ['ShazariDesertHard', [
            { missionId: MissionID.Capstone, minState: LevelHandler.MISSION_CLAIMED },
            { missionId: MissionID.IntoTheDepthsHard, minState: LevelHandler.MISSION_IN_PROGRESS }
        ]],
        ['JadeCityHard', [
            { missionId: MissionID.Capstone, minState: LevelHandler.MISSION_CLAIMED },
            { missionId: MissionID.HeadToValhavenHard, minState: LevelHandler.MISSION_READY_TO_TURN_IN }
        ]]
    ]);
    private static readonly KEEP_TUTORIAL_BOSS_TRIGGER_X = Number.MAX_SAFE_INTEGER;
    private static readonly KEEP_TUTORIAL_CUTSCENE_STEP_MS = 250;
    private static readonly KEEP_TUTORIAL_BOSS_INTRO_TOTAL_MS = 14750;
    private static readonly KEEP_TUTORIAL_BOSS_SOUND = 'D02_MoodLoop_GoblinHideout';
    private static readonly KEEP_TUTORIAL_BOSS_NAME = 'Ranik, The Geomancer';
    private static readonly KEEP_TUTORIAL_FIRST_PARROT_X = 7271;
    private static readonly KEEP_TUTORIAL_SECOND_PARROT_X = 17981;
    private static readonly TUTORIAL_DUNGEON_TRAVERSAL_ROOM_ID = 4;
    private static readonly TUTORIAL_DUNGEON_JUMP_X_THRESHOLD = 7350;
    private static readonly TUTORIAL_DUNGEON_DROP_Y_THRESHOLD = 2150;
    private static readonly TUTORIAL_DUNGEON_DROP_ROOM_EVENT = 5;

    static resetCraftTownTutorialInstance(): void {
        const levelName = 'CraftTownTutorial';
        for (const other of GlobalState.sessionsByToken.values()) {
            if (other.playerSpawned && other.currentLevel === levelName) {
                return;
            }
        }

        GlobalState.levelEntities.delete(levelName);
    }

    private static getCraftTownTutorialState(client: Client): KeepTutorialState | null {
        if (client.currentLevel !== 'CraftTownTutorial') {
            return null;
        }

        if (!client.keepTutorialState) {
            client.keepTutorialState = createKeepTutorialState();
        }

        return client.keepTutorialState;
    }

    private static sendHpUpdate(client: Client, entityId: number, delta: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(delta);
        client.sendBitBuffer(0x3A, bb);
    }

    private static sendStartSkit(client: Client, entityId: number, dialogueId: number, missionId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod6(dialogueId, 3);
        bb.writeMethod4(missionId);
        MissionHandler.noteDungeonSkitActivity(client);
        client.sendBitBuffer(0x7B, bb);
    }

    private static sendMissionAdded(client: Client, missionId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        bb.writeMethod11(1, 1);
        client.sendBitBuffer(0x85, bb);
    }

    private static sendQuestProgress(client: Client, percent: number): void {
        client.send(0xB7, LevelHandler.buildQuestProgressPayload(percent));
    }

    private static getDialogueLanguage(character: Character | null | undefined): string {
        return String(character?.dialogueLanguage ?? '').trim().toLowerCase() || 'en';
    }

    private static translateDialogueText(client: Client, text: string, fallbackToGeneric: boolean = false): string {
        return DialogueTranslationLoader.translateText(
            text,
            LevelHandler.getDialogueLanguage(client.character),
            { fallbackToGeneric }
        );
    }

    private static isEnemyRoomThought(levelName: string, levelInstanceId: string, entityId: number): boolean {
        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);
        const entity =
            GlobalState.levelEntities.get(scopeKey)?.get(entityId) ??
            GlobalState.levelEntities.get(levelName)?.get(entityId);
        return !entity || Number(entity.team ?? 0) === EntityTeam.ENEMY;
    }

    private static buildQuestProgressPayload(percent: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(LevelHandler.normalizeQuestProgress(percent) ?? 0);
        return bb.toBuffer();
    }

    private static normalizeQuestProgress(value: unknown): number | undefined {
        const progress = Number(value);
        if (!Number.isFinite(progress)) {
            return undefined;
        }

        return Math.max(0, Math.min(100, Math.round(progress)));
    }

    private static broadcastSharedDungeonQuestProgress(levelScope: string, progress: number): void {
        const payload = LevelHandler.buildQuestProgressPayload(progress);
        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== levelScope) {
                continue;
            }

            if (other.character) {
                other.character.questTrackerState = progress;
            }
            other.send(0xB7, payload);
        }
    }

    static refreshSharedDungeonQuestProgress(levelScope: string | null | undefined): number {
        const scopeKey = String(levelScope ?? '').trim();
        if (!scopeKey) {
            return 0;
        }

        const sharedState = recomputeSharedDungeonProgress(scopeKey);
        const progress = sharedState?.progress ?? 0;
        if (sharedState) {
            const authorityToken = resolveSharedDungeonProgressAuthorityToken(scopeKey);
            if (authorityToken > 0) {
                sharedState.authorityToken = authorityToken;
            }
        }

        LevelHandler.broadcastSharedDungeonQuestProgress(scopeKey, progress);
        if (progress >= 100) {
            LevelHandler.maybeAutoCompleteSharedDungeon(scopeKey, sharedState);
        }
        return progress;
    }

    private static buildSharedDungeonAutoCompletePayload(requiredKills: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod9(100);
        bb.writeMethod9(0);
        bb.writeMethod9(0);
        bb.writeMethod9(0);
        bb.writeMethod9(0);
        bb.writeMethod9(0);
        bb.writeMethod9(0);
        bb.writeMethod9(Math.max(1, requiredKills));
        bb.writeMethod9(3);
        return bb.toBuffer();
    }

    private static maybeAutoCompleteSharedDungeon(levelScope: string, sharedState: any): void {
        if (!sharedState) {
            return;
        }

        let authorityClient: Client | null = null;
        const authorityToken = Number(sharedState.authorityToken ?? 0);
        if (authorityToken > 0) {
            const authoritySession = GlobalState.sessionsByToken.get(authorityToken);
            if (authoritySession?.playerSpawned && getClientLevelScope(authoritySession) === levelScope) {
                authorityClient = authoritySession;
            }
        }

        if (!authorityClient) {
            for (const other of GlobalState.sessionsByToken.values()) {
                if (other.playerSpawned && getClientLevelScope(other) === levelScope) {
                    authorityClient = other;
                    break;
                }
            }
        }

        if (!authorityClient?.character || authorityClient.dungeonRun?.finalizedAt) {
            return;
        }

        if (
            sharedState.completionRequested &&
            (
                String(authorityClient.pendingDungeonCompletionScope ?? '').trim() === levelScope ||
                String(authorityClient.completedDungeonCompletionScope ?? '').trim() === levelScope ||
                String(authorityClient.finalizingDungeonCompletionScope ?? '').trim() === levelScope
            )
        ) {
            return;
        }

        if (
            LevelConfig.normalizeLevelName(authorityClient.currentLevel) === 'CraftTownTutorial' &&
            !authorityClient.keepTutorialState?.bossDefeated
        ) {
            return;
        }

        if (!MissionHandler.canAutoCompleteSharedDungeon(authorityClient, levelScope)) {
            return;
        }

        sharedState.completionRequested = true;
        const requiredKills = Math.max(1, getSharedDungeonProgressTotals(levelScope).total);
        MissionHandler.scheduleDungeonCompletion(
            authorityClient,
            LevelHandler.buildSharedDungeonAutoCompletePayload(requiredKills),
            MissionHandler.getSharedDungeonAutoCompleteScheduleOptions(authorityClient, levelScope)
        );
        const refreshDelay = MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS + 50;
        setTimeout(() => {
            recomputeSharedDungeonProgress(levelScope);
        }, refreshDelay).unref?.();
    }

    static syncSharedDungeonQuestProgressState(client: Client): void {
        if (!client.currentLevel || !client.character || !usesSharedDungeonProgress(client.currentLevel)) {
            return;
        }

        const levelScope = getClientLevelScope(client);
        if (!levelScope) {
            return;
        }

        const sharedState = getOrCreateSharedDungeonProgressState(levelScope);
        if (!sharedState) {
            return;
        }

        recomputeSharedDungeonProgress(levelScope);
        const authorityToken = resolveSharedDungeonProgressAuthorityToken(levelScope);
        if (authorityToken > 0) {
            sharedState.authorityToken = authorityToken;
        }

        client.character.questTrackerState = sharedState.progress;
        client.send(0xB7, LevelHandler.buildQuestProgressPayload(sharedState.progress));
    }

    static shouldSkipDungeonRoomProgressSync(levelName: string | null | undefined): boolean {
        const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
        return usesSharedDungeonProgress(normalizedLevel) ||
            normalizedLevel === 'TutorialDungeon' ||
            normalizedLevel === 'TutorialDungeonHard' ||
            normalizedLevel === 'CraftTownTutorial';
    }

    static prepareGoblinRiverDungeonEntryState(client: Client): void {
        if (!client.character || !LevelHandler.shouldSkipDungeonRoomProgressSync(client.currentLevel)) {
            return;
        }

        const normalizedLevel = LevelConfig.normalizeLevelName(client.currentLevel) || client.currentLevel;

        if (normalizedLevel === 'TutorialDungeon' || normalizedLevel === 'TutorialDungeonHard') {
            client.currentRoomId = 0;
            client.startedRoomEvents.clear();
            client.character.questTrackerState = LevelHandler.TUTORIAL_DUNGEON_INITIAL_PROGRESS;
            return;
        }

        if (normalizedLevel === 'CraftTownTutorial') {
            client.currentRoomId = 0;
            client.startedRoomEvents.clear();
            client.character.questTrackerState = 0;
            return;
        }

        client.currentRoomId = 0;
        client.startedRoomEvents.clear();
        client.character.questTrackerState = getSharedDungeonInitialProgress(client.currentLevel);
    }

    static prepareDungeonQuestProgressState(client: Client): void {
        if (
            !client.character ||
            !LevelConfig.isDungeonLevel(client.currentLevel) ||
            LevelHandler.shouldSkipDungeonRoomProgressSync(client.currentLevel)
        ) {
            return;
        }

        const progress = LevelHandler.normalizeQuestProgress(client.syncQuestProgress) ?? 0;
        client.character.questTrackerState = progress;
        if (client.playerSpawned) {
            LevelHandler.sendQuestProgress(client, progress);
        }
    }

    private static shouldClampTutorialDungeonToIntroProgress(client: Client): boolean {
        return client.currentLevel === 'TutorialDungeon' &&
            !LevelHandler.hasRoomEventStarted(client, LevelHandler.TUTORIAL_DUNGEON_DROP_ROOM_EVENT);
    }

    private static sendRoomBossInfo(
        levelName: string,
        roomId: number,
        bossId: number,
        bossName: string,
        levelInstanceId: string = ''
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(Math.max(0, roomId));
        bb.writeMethod4(bossId);
        bb.writeMethod26(bossName);
        bb.writeMethod4(0);
        bb.writeMethod26('');
        const payload = bb.toBuffer();
        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);
        markRoomBossEntity(scopeKey, bossId, roomId, bossName);

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== scopeKey) {
                continue;
            }
            other.send(0xAC, payload);
        }
        noteDungeonRunBossCutscene(scopeKey, roomId, bossId);
    }

    private static sendRoomSound(
        levelName: string,
        roomId: number,
        soundName: string,
        volume: number,
        levelInstanceId: string = ''
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(Math.max(0, roomId));
        bb.writeMethod13(soundName);
        bb.writeMethod4(Math.max(0, Math.min(100, Math.round(volume * 100))));
        const payload = bb.toBuffer();
        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== scopeKey) {
                continue;
            }
            other.send(0xA8, payload);
        }
    }

    private static sendRoomThought(levelName: string, entityId: number, text: string, levelInstanceId: string = ''): void {
        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);
        const fallbackToGeneric = LevelHandler.isEnemyRoomThought(levelName, levelInstanceId, entityId);

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== scopeKey) {
                continue;
            }

            const bb = new BitBuffer(false);
            bb.writeMethod4(entityId);
            bb.writeMethod13(LevelHandler.translateDialogueText(other, text, fallbackToGeneric));
            MissionHandler.noteDungeonSkitActivity(other);
            other.send(0x76, bb.toBuffer());
        }
    }

    private static sendRoomCutSceneStart(
        levelName: string,
        roomId: number,
        allowRoomInput: boolean,
        levelInstanceId: string = ''
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod9(Math.max(0, roomId));
        bb.writeMethod15(allowRoomInput);
        const payload = bb.toBuffer();
        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== scopeKey) {
                continue;
            }
            MissionHandler.noteDungeonCutsceneStart(other, roomId);
            other.send(0xA5, payload);
        }
    }

    private static sendRoomCutSceneEnd(levelName: string, roomId: number, levelInstanceId: string = ''): void {
        const bb = new BitBuffer(false);
        bb.writeMethod9(Math.max(0, roomId));
        const payload = bb.toBuffer();
        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== scopeKey) {
                continue;
            }
            other.send(0xA6, payload);
            MissionHandler.noteDungeonCutsceneEnd(other, roomId);
        }
    }

    private static sendRoomCamera(levelName: string, roomId: number, cameraId: number, levelInstanceId: string = ''): void {
        const bb = new BitBuffer(false);
        bb.writeMethod9(Math.max(0, roomId));
        bb.writeMethod9(Math.max(0, cameraId));
        const payload = bb.toBuffer();
        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== scopeKey) {
                continue;
            }
            other.send(0xA9, payload);
        }
    }

    private static sendNpcState(client: Client, entityId: number, entState: number, facingLeft: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(0);
        bb.writeMethod45(0);
        bb.writeMethod45(0);
        bb.writeMethod6(entState, 2);
        bb.writeMethod15(facingLeft);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        client.sendBitBuffer(0x07, bb);
    }

    private static sendSetUntargetable(client: Client, entityId: number, untargetable: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod15(untargetable);
        client.sendBitBuffer(0xAE, bb);
    }

    private static scheduleCraftTownTutorialIntroLine(
        client: Client,
        state: KeepTutorialState,
        delayMs: number,
        entityId: number | null,
        text: string
    ): void {
        if (entityId === null || !client.currentLevel) {
            return;
        }

        const levelName = client.currentLevel;
        const levelScope = getClientLevelScope(client);
        const timer = setTimeout(() => {
            if (getClientLevelScope(client) !== levelScope || client.currentLevel !== levelName || state.bossDefeated) {
                return;
            }
            LevelHandler.sendRoomThought(levelName, entityId, text, client.levelInstanceId);
        }, delayMs);

        state.introTimers.push(timer);
    }

    private static sendCraftTownTutorialBossIntroSkit(
        client: Client,
        state: KeepTutorialState,
        bossId: number | null
    ): void {
        const playerX = Number(client.character?.CurrentLevel?.x ?? 0);
        const playerY = Number(client.character?.CurrentLevel?.y ?? 0);
        const oldManId = LevelHandler.findNearestCraftTownTutorialEntity(
            client,
            new Set(['NPCHomeGemMerchant']),
            playerX,
            playerY
        ).entityId;
        const parrotId = LevelHandler.findCraftTownTutorialParrotId(client, playerX);

        if (parrotId !== null) {
            LevelHandler.teleportParrot(client, parrotId, playerX, playerY - 100);
        }

        let elapsedUnits = 0;
        const introSteps: Array<{ delayUnits: number; entityId: number | null; text: string }> = [
            { delayUnits: 0, entityId: parrotId, text: '<Goto Red 1> Look out!' },
            { delayUnits: 5, entityId: oldManId, text: "Thank the stars you're here!" },
            { delayUnits: 14, entityId: oldManId, text: 'The goblins have ruined the keep.' },
            { delayUnits: 14, entityId: oldManId, text: 'I was the caretaker here...' },
            { delayUnits: 4, entityId: bossId, text: '<Run Loop><Goto Red 2> Stop the human!' },
            { delayUnits: 10, entityId: bossId, text: "<End> Don't let him|her take our home!" }
        ];

        for (const step of introSteps) {
            elapsedUnits += step.delayUnits;
            LevelHandler.scheduleCraftTownTutorialIntroLine(
                client,
                state,
                elapsedUnits * LevelHandler.KEEP_TUTORIAL_CUTSCENE_STEP_MS,
                step.entityId,
                step.text
            );
        }
    }

    private static markCraftTownTutorialBossSeen(client: Client, entityId: number, source: 'client' | 'fallback'): void {
        const state = LevelHandler.getCraftTownTutorialState(client);
        if (!state) {
            return;
        }
        if (!state) {
            return;
        }

        state.bossEntitySeen = entityId;
        state.bossEntitySource = source;

        if (!state.bossInfoSentIds.has(entityId)) {
            LevelHandler.sendRoomBossInfo(
                client.currentLevel,
                client.currentRoomId,
                entityId,
                LevelHandler.KEEP_TUTORIAL_BOSS_NAME,
                client.levelInstanceId
            );
            state.bossInfoSentIds.add(entityId);
        }

        if (!state.bossMusicStarted) {
            LevelHandler.sendRoomSound(
                client.currentLevel,
                client.currentRoomId,
                LevelHandler.KEEP_TUTORIAL_BOSS_SOUND,
                0.9,
                client.levelInstanceId
            );
            state.bossMusicStarted = true;
        }
    }

    private static findCraftTownTutorialBossTemplate(): NpcDef | null {
        let best: NpcDef | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const npc of NpcLoader.getRawNpcsForLevel('CraftTownTutorial')) {
            if (String(npc?.name ?? '') !== 'GoblinShamanHood') {
                continue;
            }

            const distance = Math.abs(Number(npc?.x ?? 0) - 49) + Math.abs(Number(npc?.y ?? 0) - 1459);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = npc;
            }
        }

        return best;
    }

    private static spawnCraftTownTutorialFallbackBoss(client: Client): number | null {
        return null;
    }

    private static activateCraftTownTutorialBoss(client: Client, bossId: number): void {
        const state = LevelHandler.getCraftTownTutorialState(client);
        if (!state || state.bossDefeated || !client.currentLevel) {
            return;
        }

        const boss = client.entities.get(bossId);
        if (!boss) {
            return;
        }

        boss.untargetable = false;
        boss.entState = 0;

        const levelMap = LevelHandler.getCurrentLevelMap(client);
        const levelBoss = levelMap?.get(bossId);
        if (levelBoss) {
            levelBoss.untargetable = false;
            levelBoss.entState = 0;
        }

        LevelHandler.sendSetUntargetable(client, bossId, false);
        LevelHandler.sendNpcState(client, bossId, 0, Boolean(boss.facing_left ?? boss.facingLeft));
    }

    private static lockCraftTownTutorialBoss(client: Client, bossId: number): void {
        if (!client.currentLevel) {
            return;
        }

        const boss = client.entities.get(bossId);
        if (!boss) {
            return;
        }

        boss.untargetable = true;
        boss.entState = 2;

        const levelMap = LevelHandler.getCurrentLevelMap(client);
        const levelBoss = levelMap?.get(bossId);
        if (levelBoss) {
            levelBoss.untargetable = true;
            levelBoss.entState = 2;
        }

        LevelHandler.sendSetUntargetable(client, bossId, true);
        LevelHandler.sendNpcState(client, bossId, 2, Boolean(boss.facing_left ?? boss.facingLeft));
    }

    private static armCraftTownTutorialBossRecovery(client: Client, introBossId: number | null): void {
        const state = LevelHandler.getCraftTownTutorialState(client);
        if (!state || state.bossRecoveryArmed || state.bossDefeated) {
            return;
        }

        state.bossRecoveryArmed = true;
        clearKeepTutorialTimers(state);

        const levelName = client.currentLevel;
        const levelScope = getClientLevelScope(client);
        const roomId = Math.max(0, client.currentRoomId);
        if (levelName) {
            LevelHandler.sendRoomCutSceneStart(levelName, roomId, false, client.levelInstanceId);
            LevelHandler.sendRoomCamera(levelName, roomId, 1, client.levelInstanceId);
        }

        LevelHandler.sendCraftTownTutorialBossIntroSkit(client, state, introBossId);

        state.recoveryActivateTimer = setTimeout(() => {
            if (getClientLevelScope(client) !== levelScope || client.currentLevel !== levelName || state.bossDefeated) {
                return;
            }

            if (levelName) {
                LevelHandler.sendRoomCamera(levelName, roomId, 0, client.levelInstanceId);
                LevelHandler.sendRoomCutSceneEnd(levelName, roomId, client.levelInstanceId);
            }

            const bossId = state.bossEntitySeen ?? introBossId ?? LevelHandler.spawnCraftTownTutorialFallbackBoss(client);
            if (!bossId) {
                return;
            }

            const boss = client.entities.get(bossId);
            const stillLocked = !boss || Boolean(boss.untargetable) || Number(boss.entState ?? 0) === 2;
            if (state.bossEntitySource === 'fallback' || stillLocked) {
                LevelHandler.activateCraftTownTutorialBoss(client, bossId);
            }
            LevelHandler.ensureCraftTownTutorialBossEncounterEntities(client);
            if (state.helperEntityIds.length > 0) {
                LevelHandler.summonCraftTownTutorialReinforcements(client);
            }
        }, LevelHandler.KEEP_TUTORIAL_BOSS_INTRO_TOTAL_MS);
    }

    private static killCraftTownTutorialLastGuy(client: Client, lastGuyId: number | null): void {
        if (lastGuyId === null || !client.currentLevel) {
            return;
        }

        LevelHandler.sendHpUpdate(client, lastGuyId, -999999);

        const ent = client.entities.get(lastGuyId);
        if (ent) {
            ent.entState = 6;
            ent.ent_state = 6;
            ent.dead = true;
            ent.hp = 0;
        }

        const levelMap = LevelHandler.getCurrentLevelMap(client);
        const levelEnt = levelMap?.get(lastGuyId);
        if (levelEnt) {
            levelEnt.entState = 6;
            levelEnt.ent_state = 6;
            levelEnt.dead = true;
            levelEnt.hp = 0;
        }

        LevelHandler.sendDestroyEntity(client.currentLevel, lastGuyId, client.levelInstanceId);
    }

    private static selectCraftTownTutorialLastGuyId(client: Client): number | null {
        let bestId: number | null = null;
        let bestX = Number.NEGATIVE_INFINITY;

        for (const [entityId, entity] of client.entities.entries()) {
            if (String(entity?.name ?? '') !== 'GoblinDagger') {
                continue;
            }

            const cueName = String(entity?.characterName ?? entity?.character_name ?? '');
            if (cueName === 'am_LastGuy') {
                return entityId;
            }

            const dramaAnim = String(entity?.dramaAnim ?? entity?.DramaAnim ?? '');
            const sleepAnim = String(entity?.sleepAnim ?? entity?.SleepAnim ?? '');
            const entState = Number(entity?.entState ?? 0);
            if (dramaAnim === 'Board' || entState === 2 || sleepAnim) {
                continue;
            }

            const entityX = Number(entity?.x ?? 0);
            if (entityX > bestX) {
                bestX = entityX;
                bestId = entityId;
            }
        }

        return bestId;
    }

    private static classifyCraftTownTutorialFallbackEntities(levelMap: Map<number, any>): {
        lastGuyId: number | null;
        bossId: number | null;
        helperIds: number[];
    } {
        const authoredHelperIds = new Set(LevelHandler.getCraftTownTutorialAuthoredHelperIds());
        let bossId: number | null = null;
        let bossDistance = Number.POSITIVE_INFINITY;
        let lastGuyId: number | null = null;
        let lastGuyX = Number.NEGATIVE_INFINITY;
        const helperCandidates: Array<{ x: number; id: number }> = [];

        for (const [entityId, entity] of levelMap.entries()) {
            if (Number(entity?.team ?? 0) !== 2) {
                continue;
            }

            const entityName = String(entity?.name ?? '');
            const entityX = Number(entity?.x ?? 0);
            const entityY = Number(entity?.y ?? 0);
            const dramaAnim = String(entity?.dramaAnim ?? entity?.DramaAnim ?? '');
            const entState = Number(entity?.entState ?? 0);

            if (entityName === 'IntroGoblinShamanHood' || entityName === 'GoblinShamanHood') {
                const distance = Math.abs(entityX - 49) + Math.abs(entityY - 1459);
                if (distance < bossDistance) {
                    bossDistance = distance;
                    bossId = entityId;
                }
                continue;
            }

            if (entityName === 'GoblinDagger' && dramaAnim === 'Board' && authoredHelperIds.has(entityId)) {
                helperCandidates.push({ x: entityX, id: entityId });
                continue;
            }

            if (entityName === 'GoblinDagger' && entState !== 2 && entityX > lastGuyX) {
                lastGuyX = entityX;
                lastGuyId = entityId;
            }
        }

        helperCandidates.sort((a, b) => a.x - b.x);
        return {
            lastGuyId,
            bossId,
            helperIds: helperCandidates.map((entry) => entry.id)
        };
    }

    private static prepareCraftTownTutorialFallbackEntities(levelMap: Map<number, any>): {
        lastGuyId: number | null;
        bossId: number | null;
        helperIds: number[];
    } {
        const classified = LevelHandler.classifyCraftTownTutorialFallbackEntities(levelMap);

        if (classified.lastGuyId !== null) {
            const lastGuy = levelMap.get(classified.lastGuyId);
            if (lastGuy) {
                lastGuy.characterName = 'am_LastGuy';
                lastGuy.character_name = 'am_LastGuy';
            }
        }

        if (classified.bossId !== null) {
            const boss = levelMap.get(classified.bossId);
            if (boss) {
                boss.name = 'IntroGoblinShamanHood';
                boss.characterName = ',IntroGoblinShamanHood';
                boss.character_name = ',IntroGoblinShamanHood';
                boss.untargetable = true;
                boss.entState = 2;
            }
        }

        for (const helperId of classified.helperIds) {
            const helper = levelMap.get(helperId);
            if (!helper) {
                continue;
            }
            helper.untargetable = true;
            helper.entState = 2;
            helper.dramaAnim = 'Board';
            helper.DramaAnim = 'Board';
        }

        return classified;
    }

    private static mergeCraftTownTutorialHelperIds(
        state: KeepTutorialState,
        levelMap: Map<number, any>,
        helperIds: number[]
    ): void {
        const mergedIds = Array.from(new Set([...state.helperEntityIds, ...helperIds]));
        mergedIds.sort((leftId, rightId) => Number(levelMap.get(leftId)?.x ?? 0) - Number(levelMap.get(rightId)?.x ?? 0));
        state.helperEntityIds = mergedIds;
    }

    private static ensureCraftTownTutorialBossEncounterEntities(client: Client): void {
        const state = LevelHandler.getCraftTownTutorialState(client);
        if (!state || client.currentLevel !== 'CraftTownTutorial') {
            return;
        }

        const levelMap = LevelHandler.getCurrentLevelMap(client, true);
        if (!levelMap) {
            return;
        }

        const existing = LevelHandler.classifyCraftTownTutorialFallbackEntities(levelMap);

        if (existing.bossId !== null && state.bossEntitySeen === null) {
            LevelHandler.markCraftTownTutorialBossSeen(client, existing.bossId, 'client');
        }

        if (existing.helperIds.length > 0) {
            state.helperEntityIds = [...existing.helperIds];
        }
    }

    private static sendNearestCraftTownTutorialParrotSkit(client: Client): void {
        const state = LevelHandler.getCraftTownTutorialState(client);
        if (!state || state.introSkitSent) {
            return;
        }

        const playerX = Number(client.character?.CurrentLevel?.x ?? 0);
        const parrotId = LevelHandler.findCraftTownTutorialParrotId(client, playerX);
        if (parrotId === null) {
            return;
        }

        LevelHandler.sendStartSkit(client, parrotId, 0, LevelHandler.FIRST_KEEP_MISSION_ID);
        state.introSkitSent = true;
    }

    private static spawnCraftTownTutorialServerFallback(client: Client): void {
        if (client.currentLevel !== 'CraftTownTutorial') {
            return;
        }

        const levelMap = new Map<number, any>();
        for (const npc of NpcLoader.getNpcsForLevel(client.currentLevel)) {
            const entity = {
                ...Entity.fromNpc(npc),
                clientSpawned: false
            };
            levelMap.set(entity.id, entity);
        }

        const { bossId, helperIds } = LevelHandler.prepareCraftTownTutorialFallbackEntities(levelMap);
        const scopeKey = getClientLevelScope(client);
        if (scopeKey) {
            GlobalState.levelEntities.set(scopeKey, levelMap);
        }
        client.clientSpawnConfirmed = true;

        // Store helper IDs for later reinforcement spawning
        const state = LevelHandler.getCraftTownTutorialState(client);
        if (state) {
            state.helperEntityIds = [...helperIds];
        }

        let sentCount = 0;
        for (const [entityId, entity] of levelMap.entries()) {
            if (entityId === bossId || helperIds.includes(entityId)) {
                continue;
            }
            client.entities.set(entityId, { ...entity });
            noteDungeonRunEntitySeen(client, entityId, entity);
            EntityHandler.sendEntity(client, entity);
            sentCount++;
        }

        LevelHandler.sendNearestCraftTownTutorialParrotSkit(client);
        console.log(
            `[Level] Client NPC spawn fallback activated for CraftTownTutorial; sent ${sentCount} initial entities.`
        );
    }

    static scheduleClientSpawnFallback(client: Client): void {
        clearClientSpawnFallbackTimer(client);

        if (
            client.currentLevel !== 'CraftTownTutorial' ||
            !EntityHandler.isClientSpawnLevel(client.currentLevel)
        ) {
            return;
        }

        const levelName = client.currentLevel;
        const levelScope = getClientLevelScope(client);
        client.clientSpawnFallbackTimer = setTimeout(() => {
            client.clientSpawnFallbackTimer = null;
            if (getClientLevelScope(client) !== levelScope || client.currentLevel !== levelName || client.clientSpawnConfirmed) {
                return;
            }

            console.log(`[Level] No client NPC spawn packets detected for ${levelName}; enabling server fallback.`);
            if (levelName === 'CraftTownTutorial') {
                LevelHandler.spawnCraftTownTutorialServerFallback(client);
            }
        }, LevelHandler.CLIENT_SPAWN_FALLBACK_MS);
    }

    private static findNearestCraftTownTutorialEntity(
        client: Client,
        names: Set<string>,
        refX: number,
        refY: number
    ): { entityId: number | null; distance: number | null } {
        let bestId: number | null = null;
        let bestDistance: number | null = null;

        const seen = new Set<number>();
        const sources: Array<Map<number, any> | undefined> = [
            client.entities,
            LevelHandler.getCurrentLevelMap(client) ?? undefined
        ];

        for (const source of sources) {
            if (!source) {
                continue;
            }

            for (const [entityId, entity] of source.entries()) {
                if (seen.has(entityId)) {
                    continue;
                }
                seen.add(entityId);

                const entityName = String(entity?.name ?? entity?.props?.name ?? '');
                if (!names.has(entityName)) {
                    continue;
                }

                const entityX = Number(entity?.x ?? entity?.props?.x ?? entity?.props?.pos_x ?? 0);
                const entityY = Number(entity?.y ?? entity?.props?.y ?? entity?.props?.pos_y ?? 0);
                const distance = Math.abs(entityX - refX) + Math.abs(entityY - refY);
                if (bestDistance === null || distance < bestDistance) {
                    bestDistance = distance;
                    bestId = entityId;
                }
            }
        }

        return { entityId: bestId, distance: bestDistance };
    }

    private static findCraftTownTutorialParrotId(client: Client, targetX: number): number | null {
        let bestId: number | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;

        const seen = new Set<number>();
        const sources: Array<Map<number, any> | undefined> = [
            client.entities,
            LevelHandler.getCurrentLevelMap(client) ?? undefined
        ];

        for (const source of sources) {
            if (!source) {
                continue;
            }

            for (const [entityId, entity] of source.entries()) {
                if (seen.has(entityId)) {
                    continue;
                }
                seen.add(entityId);

                const entityName = String(entity?.name ?? entity?.props?.name ?? '');
                if (entityName !== 'IntroParrot') {
                    continue;
                }

                const entityX = Number(entity?.x ?? entity?.props?.x ?? entity?.props?.pos_x ?? 0);
                const distance = Math.abs(entityX - targetX);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestId = entityId;
                }
            }
        }

        return bestId;
    }

    private static findTutorialDungeonParrotId(client: Client, targetX: number): number | null {
        let bestId: number | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;

        const seen = new Set<number>();
        const sources: Array<Map<number, any> | undefined> = [
            client.entities,
            LevelHandler.getCurrentLevelMap(client) ?? undefined
        ];

        for (const source of sources) {
            if (!source) {
                continue;
            }

            for (const [entityId, entity] of source.entries()) {
                if (seen.has(entityId)) {
                    continue;
                }
                seen.add(entityId);

                const entityName = String(entity?.name ?? entity?.props?.name ?? '');
                const entityTeam = Number(entity?.team ?? entity?.props?.team ?? 0);
                if (entityName !== 'IntroParrot' || (entityTeam !== 0 && entityTeam !== 3)) {
                    continue;
                }

                const entityX = Number(entity?.x ?? entity?.props?.x ?? entity?.props?.pos_x ?? 0);
                const distance = Math.abs(entityX - targetX);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestId = entityId;
                }
            }
        }

        return bestId;
    }

    private static maybeTriggerCraftTownTutorialParrot(client: Client, newX: number): void {
        const state = LevelHandler.getCraftTownTutorialState(client);
        if (!state || state.bossDefeated) {
            return;
        }

        const player = client.entities.get(client.clientEntID);
        const playerX = Number(player?.x ?? newX);
        const playerY = Number(player?.y ?? 0);

        if (state.phase < 1 && newX >= 8650) {
            const parrotId = LevelHandler.findCraftTownTutorialParrotId(
                client,
                LevelHandler.KEEP_TUTORIAL_FIRST_PARROT_X
            );
            if (parrotId !== null) {
                LevelHandler.teleportParrotAndStartSkit(client, parrotId, newX, playerY - 100);
            }
            state.phase = 1;
            return;
        }

        if (state.phase < 2 && newX >= 19400) {
            const parrotId = LevelHandler.findCraftTownTutorialParrotId(
                client,
                LevelHandler.KEEP_TUTORIAL_SECOND_PARROT_X
            );
            if (parrotId !== null) {
                LevelHandler.teleportParrotAndStartSkit(client, parrotId, newX, playerY - 100);
            }
            state.phase = 2;
            return;
        }

        // --- Follow Logic ---
        if (state.phase >= 1 && state.phase <= 2) {
            const anchorX = (state.phase === 1) 
                ? LevelHandler.KEEP_TUTORIAL_FIRST_PARROT_X 
                : LevelHandler.KEEP_TUTORIAL_SECOND_PARROT_X;
                
            const parrotId = LevelHandler.findCraftTownTutorialParrotId(client, anchorX);
            if (parrotId !== null) {
                const parrotEnt = client.entities.get(parrotId);
                if (parrotEnt) {
                    const dist = Math.abs(parrotEnt.x - newX);
                    // If player is more than 600px away, teleport parrot to follow
                    if (dist > 600) {
                        LevelHandler.teleportParrot(client, parrotId, newX, playerY - 100);
                    }
                }
            }
        }

        if (state.phase >= 3) {
            return;
        }

        const oldMan = LevelHandler.findNearestCraftTownTutorialEntity(
            client,
            new Set(['NPCHomeGemMerchant']),
            playerX,
            playerY
        );

        const distanceToOldMan = Number(oldMan.distance ?? 999999);
        const reachedBossTrigger =
            newX >= LevelHandler.KEEP_TUTORIAL_BOSS_TRIGGER_X ||
            (state.phase >= 2 && oldMan.entityId !== null && distanceToOldMan <= 700);

        if (reachedBossTrigger) {
            LevelHandler.maybeTriggerCraftTownTutorialBossIntro(client);
        }
    }

    private static teleportParrot(client: Client, parrotId: number, x: number, y: number): void {
        const levelMap = LevelHandler.getCurrentLevelMap(client);
        const levelParrot = levelMap?.get(parrotId);
        if (!client.entities.has(parrotId) && levelParrot) {
            client.entities.set(parrotId, { ...levelParrot });
        }

        const parrotEnt = client.entities.get(parrotId);
        if (parrotEnt) {
            const dx = Math.round(x - parrotEnt.x);
            const dy = Math.round(y - parrotEnt.y);

            // 1. Update server-side position BEFORE ensuring it's known
            // This ensures the spawn packet (if sent) has the right coords.
            parrotEnt.x = x;
            parrotEnt.y = y;
            
            const globalParrot = levelMap?.get(parrotId);
            if (globalParrot) {
                globalParrot.x = x;
                globalParrot.y = y;
            }

            // 2. Ensure client knows it. If not known, this sends a Spawn (0x0F).
            const wasKnown = client.knownEntityIds.has(parrotId);
            EntityHandler.ensureEntityKnown(client, client.currentLevel, parrotId);

            // 3. If it WAS already known, send an incremental move (0x07) to the client
            // This avoids Error #2015: Invalid BitmapData from Destroy+Spawn cycles.
            const suppressIncrementalMove =
                client.currentLevel === 'TutorialDungeon' &&
                String(parrotEnt.name ?? '') === 'IntroParrot';
            if (wasKnown && (dx !== 0 || dy !== 0) && !suppressIncrementalMove) {
                EntityHandler.sendNpcMove(client, parrotId, dx, dy, parrotEnt.entState ?? 0, parrotEnt.facingLeft ?? false);
            }
        }
    }

    private static teleportParrotAndStartSkit(client: Client, parrotId: number, x: number, y: number): void {
        LevelHandler.teleportParrot(client, parrotId, x, y);
        
        // 4. Start skit
        LevelHandler.sendStartSkit(client, parrotId, 0, LevelHandler.FIRST_KEEP_MISSION_ID);
    }

    private static snapCraftTownTutorialParrotToPlayer(client: Client): number | null {
        const player = client.entities.get(client.clientEntID);
        const playerX = Number(player?.x ?? client.character?.CurrentLevel?.x ?? 0);
        const playerY = Number(player?.y ?? client.character?.CurrentLevel?.y ?? 0);
        const parrotId = LevelHandler.findCraftTownTutorialParrotId(client, playerX);
        if (parrotId !== null) {
            LevelHandler.teleportParrot(client, parrotId, playerX, playerY - 100);
        }
        return parrotId;
    }

    private static maybeTriggerCraftTownTutorialBossIntro(client: Client): void {
        const state = LevelHandler.getCraftTownTutorialState(client);
        if (!state || state.bossDefeated || state.bossIntroForced) {
            return;
        }

        const lastGuyId = LevelHandler.selectCraftTownTutorialLastGuyId(client);
        state.phase = 3;
        state.bossIntroForced = true;
        state.forcedLastGuyId = lastGuyId;

        LevelHandler.ensureCraftTownTutorialBossEncounterEntities(client);
        LevelHandler.snapCraftTownTutorialParrotToPlayer(client);

        LevelHandler.killCraftTownTutorialLastGuy(client, lastGuyId);

        const bossId = state.bossEntitySeen ?? LevelHandler.spawnCraftTownTutorialFallbackBoss(client);
        if (bossId !== null) {
            LevelHandler.lockCraftTownTutorialBoss(client, bossId);
        }

        console.log(
            `[CraftTownTutorial] Starting forced boss intro; lastGuy=${lastGuyId ?? 'missing'}, boss=${bossId ?? 'missing'}.`
        );

        LevelHandler.armCraftTownTutorialBossRecovery(client, bossId);
    }

    private static pruneCraftTownTutorialActiveHelperIds(client: Client, state: KeepTutorialState): void {
        const levelMap = LevelHandler.getCurrentLevelMap(client);
        state.helperWaveActiveIds = state.helperWaveActiveIds.filter((helperId) => {
            const helper = levelMap?.get(helperId) ?? client.entities.get(helperId);
            if (!helper) {
                return false;
            }

            const entState = Number(helper.entState ?? helper.ent_state ?? 0);
            return !Boolean(helper.dead) && entState !== 3 && entState !== 6;
        });
    }

    private static getNextCraftTownTutorialHelperWaveIds(state: KeepTutorialState, helperIds: number[]): number[] {
        if (helperIds.length === 0) {
            return [];
        }

        const preferredSize = state.helperWaveUseSmallNext ? 2 : 3;
        state.helperWaveUseSmallNext = !state.helperWaveUseSmallNext;

        const waveSize = Math.min(helperIds.length, preferredSize);
        const startIndex = helperIds.length > 0 ? state.helperWaveCursor % helperIds.length : 0;
        const selectedIds: number[] = [];

        for (let offset = 0; offset < helperIds.length && selectedIds.length < waveSize; offset++) {
            const helperId = helperIds[(startIndex + offset) % helperIds.length];
            if (!selectedIds.includes(helperId)) {
                selectedIds.push(helperId);
            }
        }

        if (helperIds.length > 0) {
            state.helperWaveCursor = (startIndex + selectedIds.length) % helperIds.length;
        }

        return selectedIds;
    }

    private static scheduleCraftTownTutorialReinforcementRespawn(client: Client, delayMs: number): void {
        const state = LevelHandler.getCraftTownTutorialState(client);
        if (!state || state.bossDefeated || state.helperWaveRespawnTimer) {
            return;
        }

        LevelHandler.pruneCraftTownTutorialActiveHelperIds(client, state);
        if (state.helperWaveActiveIds.length > 0) {
            return;
        }

        const levelName = client.currentLevel;
        const levelScope = getClientLevelScope(client);
        state.helperWaveRespawnTimer = setTimeout(() => {
            state.helperWaveRespawnTimer = null;
            if (getClientLevelScope(client) !== levelScope || client.currentLevel !== levelName || state.bossDefeated) {
                return;
            }

            LevelHandler.summonCraftTownTutorialReinforcements(client);
        }, delayMs);
    }

    private static triggerCraftTownTutorialBossReinforcementThought(
        client: Client,
        state: KeepTutorialState,
        text: string
    ): void {
        if (!client.currentLevel || state.bossEntitySeen === null) {
            return;
        }

        LevelHandler.sendRoomThought(client.currentLevel, state.bossEntitySeen, text, client.levelInstanceId);
        LevelHandler.pruneCraftTownTutorialActiveHelperIds(client, state);
        if (state.helperWaveActiveIds.length === 0) {
            LevelHandler.summonCraftTownTutorialReinforcements(client);
        }
    }

    private static summonCraftTownTutorialReinforcements(client: Client): void {
        const state = LevelHandler.getCraftTownTutorialState(client);
        if (!state || !client.currentLevel) {
            return;
        }

        const authoredHelperIds = new Set(LevelHandler.getCraftTownTutorialAuthoredHelperIds());
        if (authoredHelperIds.size > 0) {
            state.helperEntityIds = state.helperEntityIds.filter((helperId) => authoredHelperIds.has(helperId));
        }

        LevelHandler.pruneCraftTownTutorialActiveHelperIds(client, state);
        if (state.helperWaveActiveIds.length > 0) {
            return;
        }

        const preferredHelperIds = state.helperEntityIds.filter((helperId) => {
            const helper =
                LevelHandler.getCurrentLevelMap(client)?.get(helperId) ??
                client.entities.get(helperId);
            return Boolean(helper);
        });

        LevelHandler.ensureCraftTownTutorialBossEncounterEntities(client);
        const levelMap = LevelHandler.getCurrentLevelMap(client, true);
        if (!levelMap) {
            return;
        }

        const orderedHelperIds = Array.from(new Set([...preferredHelperIds, ...state.helperEntityIds]));
        const waveIds = LevelHandler.getNextCraftTownTutorialHelperWaveIds(state, orderedHelperIds);
        if (waveIds.length === 0) {
            return;
        }

        let spawnedCount = 0;
        const activeIds: number[] = [];
        for (const helperId of waveIds) {
            const helper = levelMap.get(helperId) ?? client.entities.get(helperId);
            if (!helper) {
                continue;
            }

            if (!levelMap.has(helperId)) {
                levelMap.set(helperId, { ...helper });
            }

            helper.untargetable = false;
            helper.entState = 0;
            helper.dramaAnim = '';
            helper.DramaAnim = '';

            const existing = client.entities.get(helperId);
            if (existing) {
                existing.untargetable = false;
                existing.entState = 0;
                existing.dramaAnim = '';
                existing.DramaAnim = '';
            }

            const helperSnapshot = { ...helper };
            client.entities.set(helperId, helperSnapshot);
            noteDungeonRunEntitySeen(client, helperId, helperSnapshot);

            if (!client.knownEntityIds.has(helperId)) {
                EntityHandler.sendEntity(client, helperSnapshot);
            } else {
                LevelHandler.sendSetUntargetable(client, helperId, false);
                LevelHandler.sendNpcState(client, helperId, 0, Boolean(helper.facing_left ?? helper.facingLeft));
            }

            activeIds.push(helperId);
            spawnedCount++;
        }

        state.helperWaveActiveIds = activeIds;

        if (spawnedCount > 0) {
            console.log(`[CraftTownTutorial] Summoned helper wave (${spawnedCount}): ${activeIds.join(', ')}.`);
        }
    }

    static noteCraftTownTutorialHelperDestroyed(client: Client, entityId: number): void {
        const state = LevelHandler.getCraftTownTutorialState(client);
        if (
            !state ||
            state.bossDefeated ||
            !state.helperEntityIds.includes(entityId)
        ) {
            return;
        }

        state.helperWaveActiveIds = state.helperWaveActiveIds.filter((helperId) => helperId !== entityId);
        if (state.helperWaveActiveIds.length > 0) {
            return;
        }

        LevelHandler.scheduleCraftTownTutorialReinforcementRespawn(
            client,
            LevelHandler.KEEP_TUTORIAL_HELPER_RESPAWN_DELAY_MS
        );
    }

    /**
     * Check boss health and trigger reinforcement waves at 60% and 30% HP.
     * Called from CombatHandler when a power hit lands on the boss entity.
     */
    static checkCraftTownTutorialBossHealth(client: Client, targetId: number, damage: number): void {
        const state = LevelHandler.getCraftTownTutorialState(client);
        if (!state || state.bossDefeated || damage <= 0) {
            return;
        }

        // Only process hits on the boss entity
        if (state.bossEntitySeen !== targetId) {
            return;
        }

        const boss = client.entities.get(targetId);
        if (!boss) {
            return;
        }

        const healthDelta = Number(boss.health_delta ?? boss.healthDelta ?? 0) - Math.abs(damage);
        boss.health_delta = healthDelta;
        boss.healthDelta = healthDelta;
        const levelBoss = LevelHandler.getCurrentLevelMap(client)?.get(targetId);
        if (levelBoss) {
            levelBoss.health_delta = healthDelta;
            levelBoss.healthDelta = healthDelta;
        }

        const totalDamageDealt = Math.abs(healthDelta);

        if (!state.bossWounded60 && totalDamageDealt > 1500) {
            state.bossWounded60 = true;
            console.log('[CraftTownTutorial] Boss wounded (60%).');
            LevelHandler.triggerCraftTownTutorialBossReinforcementThought(
                client,
                state,
                'To me! Protect your home!'
            );
        }

        if (!state.bossWounded30 && totalDamageDealt > 3000) {
            state.bossWounded30 = true;
            console.log('[CraftTownTutorial] Boss critical (30%).');
            LevelHandler.triggerCraftTownTutorialBossReinforcementThought(
                client,
                state,
                'I will not fall! To me, brothers!'
            );
        }

        if (state.helperWaveActiveIds.length === 0 && !state.helperWaveRespawnTimer) {
            LevelHandler.scheduleCraftTownTutorialReinforcementRespawn(client, 0);
        }
    }

    private static getCharacterMissionState(character: any, missionId: number): number {
        const missions = character?.missions;
        if (!missions || typeof missions !== 'object' || Array.isArray(missions)) {
            return LevelHandler.MISSION_NOT_STARTED;
        }

        const entry = missions[String(missionId)];
        return Number(entry?.state ?? LevelHandler.MISSION_NOT_STARTED);
    }

    private static canStartMission(character: any, missionId: number): boolean {
        const missionDef = MissionLoader.getMissionDef(missionId);
        if (!missionDef) {
            return false;
        }

        for (const prereqName of missionDef.PreReqMissions ?? []) {
            const prereqId = MissionLoader.getMissionIdByName(prereqName);
            if (!prereqId) {
                continue;
            }
            if (LevelHandler.getCharacterMissionState(character, prereqId) < 3) {
                return false;
            }
        }

        return true;
    }

    static async prepareCraftTownTutorialEntry(client: Client): Promise<void> {
        if (client.currentLevel !== 'CraftTownTutorial' || !client.character) {
            return;
        }

        const state = LevelHandler.getCraftTownTutorialState(client);

        const missionState = LevelHandler.getCharacterMissionState(client.character, LevelHandler.FIRST_KEEP_MISSION_ID);
        const shouldResetKeepMission =
            missionState === LevelHandler.MISSION_IN_PROGRESS ||
            (
                missionState === LevelHandler.MISSION_NOT_STARTED &&
                LevelHandler.canStartMission(client.character, LevelHandler.FIRST_KEEP_MISSION_ID)
            );
        if (
            shouldResetKeepMission
        ) {
            const missions =
                client.character.missions &&
                typeof client.character.missions === 'object' &&
                !Array.isArray(client.character.missions)
                    ? client.character.missions
                    : {};

            missions[String(LevelHandler.FIRST_KEEP_MISSION_ID)] = {
                ...(missions[String(LevelHandler.FIRST_KEEP_MISSION_ID)] ?? {}),
                state: LevelHandler.MISSION_IN_PROGRESS,
                currCount: 0
            };
            delete missions[String(LevelHandler.FIRST_KEEP_MISSION_ID)].claimed;
            delete missions[String(LevelHandler.FIRST_KEEP_MISSION_ID)].complete;
            client.character.missions = missions;
            client.character.questTrackerState = 0;
            DebugLogger.logProgress('CraftTownTutorial:bootstrapMission', client, client.character, {
                missionId: LevelHandler.FIRST_KEEP_MISSION_ID
            });

            if (missionState === LevelHandler.MISSION_NOT_STARTED) {
                LevelHandler.sendMissionAdded(client, LevelHandler.FIRST_KEEP_MISSION_ID);
            }
            LevelHandler.sendQuestProgress(client, 0);

            if (client.userId) {
                await db.saveCharacters(client.userId, client.characters);
            }
        }

        if (state!.introSkitSent) {
            return;
        }

        const levelMap = LevelHandler.getCurrentLevelMap(client);
        if (!levelMap) {
            return;
        }

        const playerX = Number(client.character.CurrentLevel?.x ?? 0);
        const playerY = Number(client.character.CurrentLevel?.y ?? 0);
        let parrotId: number | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const [entityId, entity] of levelMap.entries()) {
            if (String(entity?.name ?? entity?.props?.name ?? '') !== 'IntroParrot') {
                continue;
            }

            const entityX = Number(entity?.x ?? entity?.props?.x ?? entity?.props?.pos_x ?? 0);
            const entityY = Number(entity?.y ?? entity?.props?.y ?? entity?.props?.pos_y ?? 0);
            const distance = Math.abs(entityX - playerX) + Math.abs(entityY - playerY);
            if (distance < bestDistance) {
                bestDistance = distance;
                parrotId = entityId;
            }
        }

        if (parrotId !== null) {
            LevelHandler.sendStartSkit(client, parrotId, 0, LevelHandler.FIRST_KEEP_MISSION_ID);
            state!.introSkitSent = true;
        }
    }

    private static async refreshCurrentCharacterFromSave(client: Client): Promise<void> {
        if (!client.userId || !client.character) {
            return;
        }

        const latestCharacters = await db.loadCharacters(client.userId);
        client.characters = latestCharacters;

        const currentName = String(client.character.name ?? '').trim().toLowerCase();
        const latestCharacter = latestCharacters.find((entry) =>
            String(entry?.name ?? '').trim().toLowerCase() === currentName
        );

        if (latestCharacter) {
            client.character = latestCharacter;
        } else {
            latestCharacters.push(client.character);
            client.characters = latestCharacters;
        }
    }

    private static async saveCurrentCharacterSnapshot(client: Client): Promise<void> {
        if (!client.userId || !client.character) {
            return;
        }

        client.characters = await db.saveCharacterSnapshot(client.userId, client.character);
    }

    private static scheduleCurrentCharacterSnapshot(client: Client, reason: string): void {
        if (!client.userId || !client.character) {
            return;
        }

        const index = client.characters.findIndex((entry) => entry.name === client.character?.name);
        if (index >= 0) {
            client.characters[index] = client.character;
        } else {
            client.characters.push(client.character);
        }
        client.scheduleCharacterSave(reason);
    }

    private static getLevelMap(
        levelName: string | null | undefined,
        levelInstanceId: string = '',
        createIfMissing: boolean = false
    ): Map<number, any> | null {
        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);
        if (!scopeKey) {
            return null;
        }

        let levelMap = GlobalState.levelEntities.get(scopeKey) ?? null;
        if (!levelMap && createIfMissing) {
            levelMap = new Map<number, any>();
            GlobalState.levelEntities.set(scopeKey, levelMap);
        }

        return levelMap;
    }

    private static getCurrentLevelMap(client: Pick<Client, 'currentLevel' | 'levelInstanceId'>, createIfMissing: boolean = false): Map<number, any> | null {
        return LevelHandler.getLevelMap(client.currentLevel, client.levelInstanceId, createIfMissing);
    }

    private static sendDestroyEntity(levelName: string, entityId: number, levelInstanceId: string = ''): void {
        EntityHandler.broadcastDestroyEntity(levelName, entityId, null, levelInstanceId);
    }

    private static clearTransferState(client: Client, oldLevel: string, oldClientEntId: number): void {
        clearClientSpawnFallbackTimer(client);
        clearKeepTutorialTimers(client.keepTutorialState);
        client.keepTutorialState = null;
        if (client.goblinRiverBossIntroUnlockTimer) {
            clearTimeout(client.goblinRiverBossIntroUnlockTimer);
            client.goblinRiverBossIntroUnlockTimer = null;
        }
        client.goblinRiverBossIntroLockUntil = 0;
        client.clientSpawnConfirmed = false;
        client.entities.delete(oldClientEntId);
        EntityHandler.removeOwnedEntities(client);
        client.clientEntID = 0;
        client.playerSpawned = false;
        client.pendingLoot.clear();
        client.processedRewardSources.clear();
        client.triggeredLevelStates.clear();
        finalizeDungeonRun(client, 'leave');
        client.dungeonRun = null;
        client.currentRoomId = 0;
        client.startedRoomEvents.clear();
        client.levelInstanceId = '';
        client.syncAnchorStartedAt = 0;
        client.syncAnchorToken = 0;
        client.syncAnchorCharacterName = '';
    }

    private static forLevelRecipients(client: Client, includeSender: boolean = false): Client[] {
        const levelName = client.currentLevel;
        if (!levelName) {
            return [];
        }

        const recipients: Client[] = [];
        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || !areClientsInSameLevelScope(client, other)) {
                continue;
            }
            if (!includeSender && other === client) {
                continue;
            }
            recipients.push(other);
        }

        return recipients;
    }

    private static relayToLevel(client: Client, packetId: number, data: Buffer, includeSender: boolean = false): void {
        for (const other of LevelHandler.forLevelRecipients(client, includeSender)) {
            other.send(packetId, data);
        }
    }

    private static buildEntityIncrementalUpdatePayload(
        entityId: number,
        deltaX: number,
        deltaY: number,
        deltaVX: number,
        entState: number,
        flags: {
            bLeft: boolean;
            bRunning: boolean;
            bJumping: boolean;
            bDropping: boolean;
            bBackpedal: boolean;
        },
        isAirborne: boolean,
        velocityY: number
    ): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(deltaX);
        bb.writeMethod45(deltaY);
        bb.writeMethod45(deltaVX);
        bb.writeMethod6(entState, 2);
        bb.writeMethod15(flags.bLeft);
        bb.writeMethod15(flags.bRunning);
        bb.writeMethod15(flags.bJumping);
        bb.writeMethod15(flags.bDropping);
        bb.writeMethod15(flags.bBackpedal);
        bb.writeMethod15(isAirborne);
        if (isAirborne) {
            bb.writeMethod24(velocityY);
        }
        return bb.toBuffer();
    }

    private static cacheRoomId(client: Client, roomId: number): void {
        if (Number.isFinite(roomId) && roomId >= 0) {
            const previousRoomId = Number.isFinite(Number(client.currentRoomId))
                ? Math.round(Number(client.currentRoomId))
                : -1;
            client.currentRoomId = roomId;
            if (previousRoomId >= 0 && previousRoomId !== roomId) {
                PetHandler.armMountTravelProtection(client, 4000, true);
            }
            LevelHandler.maybeStartTutorialDungeonTraversalTutorial(client, roomId);
        }
    }

    static isGoblinRiverBossIntroLocked(client: Client): boolean {
        const currentLockUntil = Number(client.goblinRiverBossIntroLockUntil ?? 0);
        if (currentLockUntil > Date.now()) {
            return true;
        }

        const levelScope = getClientLevelScope(client);
        if (!levelScope) {
            return false;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== levelScope) {
                continue;
            }
            if (!sharesRoomIds(client.currentRoomId, other.currentRoomId)) {
                continue;
            }
            if (Number(other.goblinRiverBossIntroLockUntil ?? 0) > Date.now()) {
                return true;
            }
        }

        return false;
    }

    static isDungeonCutsceneCombatLocked(client: Client): boolean {
        const levelScope = getClientLevelScope(client);
        if (!levelScope) {
            return false;
        }

        const clientRoomId = Number.isFinite(Number(client.currentRoomId))
            ? Math.round(Number(client.currentRoomId))
            : -1;
        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== levelScope) {
                continue;
            }
            if (String(other.activeDungeonCutsceneScope ?? '').trim() !== levelScope) {
                continue;
            }
            const startedAt = Number(other.lastDungeonCutsceneStartAt ?? 0);
            if (startedAt > 0 && Date.now() - startedAt > LevelHandler.DUNGEON_CUTSCENE_COMBAT_LOCK_MAX_MS) {
                continue;
            }

            const cutsceneRoomId = Number.isFinite(Number(other.activeDungeonCutsceneRoomId))
                ? Math.round(Number(other.activeDungeonCutsceneRoomId))
                : -1;
            if (cutsceneRoomId < 0) {
                return true;
            }
            if (clientRoomId < 0 || sharesRoomIds(clientRoomId, cutsceneRoomId)) {
                return true;
            }
        }

        return false;
    }

    private static maybeStartTutorialDungeonTraversalTutorial(client: Client, roomId: number): void {
        if (
            client.currentLevel !== 'TutorialDungeon' ||
            !Number.isFinite(roomId) ||
            roomId < 0 ||
            roomId !== LevelHandler.TUTORIAL_DUNGEON_TRAVERSAL_ROOM_ID ||
            LevelHandler.hasRoomEventStarted(client, roomId)
        ) {
            return;
        }

        LevelHandler.sendRoomEventStart(client, roomId, true);
    }

    private static maybeTriggerTutorialDungeonDropTutorial(
        client: Client,
        currentX: number,
        currentY: number,
        flags?: { bJumping?: boolean; bDropping?: boolean }
    ): void {
        if (client.currentLevel !== 'TutorialDungeon') {
            return;
        }

        if (client.currentRoomId !== LevelHandler.TUTORIAL_DUNGEON_TRAVERSAL_ROOM_ID) {
            return;
        }

        const performedTraversalInput = Boolean(flags?.bJumping || flags?.bDropping);
        const hasJumped = currentX > LevelHandler.TUTORIAL_DUNGEON_JUMP_X_THRESHOLD;
        const hasDropped = currentY > LevelHandler.TUTORIAL_DUNGEON_DROP_Y_THRESHOLD;

        if (
            (performedTraversalInput || hasJumped || hasDropped) &&
            !LevelHandler.hasRoomEventStarted(client, LevelHandler.TUTORIAL_DUNGEON_DROP_ROOM_EVENT)
        ) {
            LevelHandler.sendRoomEventStart(client, LevelHandler.TUTORIAL_DUNGEON_DROP_ROOM_EVENT, true);
        }
    }

    private static maybeTriggerDeepgardDragonMiniBossIntro(
        client: Client,
        previousX: number,
        currentX: number,
        currentY: number
    ): void {
        const currentLevel = LevelConfig.normalizeLevelName(client.currentLevel);
        if (currentLevel !== 'AC_Mission1' && currentLevel !== 'AC_Mission1Hard') {
            return;
        }

        const roomId = LevelHandler.DEEPGARD_DRAGON_MINIBOSS_ROOM_ID;
        const triggerKey = `${currentLevel}:${roomId}:am_Trigger_Cutscene`;
        if (client.triggeredLevelStates.has(triggerKey)) {
            return;
        }

        const crossedTrigger =
            previousX < LevelHandler.DEEPGARD_DRAGON_MINIBOSS_TRIGGER_X &&
            currentX >= LevelHandler.DEEPGARD_DRAGON_MINIBOSS_TRIGGER_X;
        const insideTriggerBand =
            currentY >= LevelHandler.DEEPGARD_DRAGON_MINIBOSS_TRIGGER_MIN_Y &&
            currentY <= LevelHandler.DEEPGARD_DRAGON_MINIBOSS_TRIGGER_MAX_Y;

        if (!crossedTrigger || !insideTriggerBand) {
            return;
        }

        for (const other of LevelHandler.forLevelRecipients(client, true)) {
            if (!other.triggeredLevelStates.has(triggerKey)) {
                other.triggeredLevelStates.add(triggerKey);
                LevelHandler.sendRoomTriggerState(other, roomId, 'am_Trigger_Cutscene');
            }
        }
    }

    private static maybeTriggerBackAlleyDealsBossIntro(
        client: Client,
        previousX: number,
        currentX: number,
        currentY: number
    ): void {
        const currentLevel = LevelConfig.normalizeLevelName(client.currentLevel);
        if (currentLevel !== 'JC_Mission2' && currentLevel !== 'JC_Mission2Hard') {
            return;
        }

        const roomId = LevelHandler.BACK_ALLEY_DEALS_BOSS_ROOM_ID;
        const triggerKey = `${currentLevel}:${roomId}:am_Trigger_Boss`;
        if (client.triggeredLevelStates.has(triggerKey)) {
            return;
        }

        const crossedTrigger =
            previousX < LevelHandler.BACK_ALLEY_DEALS_BOSS_TRIGGER_X &&
            currentX >= LevelHandler.BACK_ALLEY_DEALS_BOSS_TRIGGER_X;
        const insideTriggerBand =
            currentY >= LevelHandler.BACK_ALLEY_DEALS_BOSS_TRIGGER_MIN_Y &&
            currentY <= LevelHandler.BACK_ALLEY_DEALS_BOSS_TRIGGER_MAX_Y;
        const alreadyPastTrigger = currentX >= LevelHandler.BACK_ALLEY_DEALS_BOSS_TRIGGER_X;

        if (!(crossedTrigger || alreadyPastTrigger) || !insideTriggerBand) {
            return;
        }

        for (const other of LevelHandler.forLevelRecipients(client, true)) {
            if (!other.triggeredLevelStates.has(triggerKey)) {
                other.currentRoomId = roomId;
                if (!LevelHandler.hasRoomEventStarted(other, roomId)) {
                    LevelHandler.sendRoomEventStart(other, roomId, true);
                }
                other.triggeredLevelStates.add(triggerKey);
                LevelHandler.sendRoomTriggerState(other, roomId, 'am_Trigger_Boss');
            }
        }
    }

    private static maybeTriggerProdigalSonDefectorMoment(
        client: Client,
        previousX: number,
        currentX: number,
        currentY: number
    ): void {
        const currentLevel = LevelConfig.normalizeLevelName(client.currentLevel);
        if (currentLevel !== 'JC_Mission3' && currentLevel !== 'JC_Mission3Hard') {
            return;
        }

        for (const trigger of LevelHandler.PRODIGAL_SON_DEFECTOR_TRIGGERS) {
            const triggerKey = `${currentLevel}:${trigger.roomId}:${trigger.triggerName}`;
            if (client.triggeredLevelStates.has(triggerKey)) {
                continue;
            }

            const crossedTrigger =
                previousX < trigger.triggerX &&
                currentX >= trigger.triggerX;
            const insideTriggerBand =
                currentY >= trigger.triggerMinY &&
                currentY <= trigger.triggerMaxY;

            if (!crossedTrigger || !insideTriggerBand) {
                continue;
            }

            for (const other of LevelHandler.forLevelRecipients(client, true)) {
                if (!other.triggeredLevelStates.has(triggerKey)) {
                    other.triggeredLevelStates.add(triggerKey);
                    LevelHandler.sendRoomTriggerState(other, trigger.roomId, trigger.triggerName);
                }
            }
        }
    }

    private static sendRoomTriggerState(client: Client, roomId: number, triggerName: string): void {
        const bb = new BitBuffer(false);
        bb.writeMethod26(`${Math.max(0, Math.round(roomId))}^Trigger^${triggerName}`);
        bb.writeMethod26('');
        client.sendBitBuffer(0x40, bb);
    }

    private static setGoblinRiverHostilesUntargetable(client: Client, untargetable: boolean): void {
        const levelMap = LevelHandler.getCurrentLevelMap(client);
        if (!levelMap) {
            return;
        }

        const targetState = untargetable ? 2 : 0;
        for (const [entityId, entity] of levelMap.entries()) {
            if (!entity || Boolean(entity.isPlayer)) {
                continue;
            }

            const entityRoomId = Number(entity.roomId ?? -1);
            if (!sharesRoomIds(client.currentRoomId, entityRoomId)) {
                continue;
            }

            entity.untargetable = untargetable;
            entity.entState = targetState;

            for (const recipient of LevelHandler.forLevelRecipients(client, true)) {
                const localEntity = recipient.entities.get(entityId);
                if (localEntity) {
                    localEntity.untargetable = untargetable;
                    localEntity.entState = targetState;
                }
                LevelHandler.sendSetUntargetable(recipient, entityId, untargetable);
                LevelHandler.sendNpcState(
                    recipient,
                    entityId,
                    targetState,
                    Boolean(entity.facing_left ?? entity.facingLeft)
                );
            }
        }
    }

    private static clearGoblinRiverBossIntroLock(client: Client): void {
        if (client.goblinRiverBossIntroUnlockTimer) {
            clearTimeout(client.goblinRiverBossIntroUnlockTimer);
            client.goblinRiverBossIntroUnlockTimer = null;
        }
        if (client.currentLevel) {
            LevelHandler.sendRoomCutSceneEnd(client.currentLevel, Math.max(0, client.currentRoomId), client.levelInstanceId);
        }
        client.goblinRiverBossIntroLockUntil = 0;
        LevelHandler.setGoblinRiverHostilesUntargetable(client, false);
    }

    private static isGoblinRiverBossIntroLevel(levelName: string | null | undefined): boolean {
        const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
        return normalizedLevel === 'GoblinRiverDungeon' || normalizedLevel === 'GoblinRiverDungeonHard';
    }

    static maybeStartGoblinRiverBossIntroLock(client: Client, entityId: number, text: string): void {
        if (!LevelHandler.isGoblinRiverBossIntroLevel(client.currentLevel)) {
            return;
        }
        if (!LevelHandler.GOBLIN_RIVER_BOSS_INTRO_TEXTS.has(String(text ?? '').trim())) {
            return;
        }

        const entity =
            client.entities.get(entityId) ??
            LevelHandler.getCurrentLevelMap(client)?.get(entityId);
        const entityName = String(entity?.name ?? '');
        if (
            entityName !== 'GoblinBoss1' &&
            entityName !== 'GoblinBoss1Hard' &&
            entityName !== 'GoblinBoss2' &&
            entityName !== 'GoblinBoss2Hard'
        ) {
            return;
        }

        const lockUntil = Date.now() + LevelHandler.GOBLIN_RIVER_BOSS_INTRO_DEFAULT_MS;
        const existingLockUntil = Number(client.goblinRiverBossIntroLockUntil ?? 0);
        const wasLocked = Number.isFinite(existingLockUntil) && existingLockUntil > Date.now();
        client.goblinRiverBossIntroLockUntil = Math.max(
            Number.isFinite(existingLockUntil) ? existingLockUntil : 0,
            lockUntil
        );
        if (!wasLocked && client.currentLevel) {
            LevelHandler.sendRoomCutSceneStart(
                client.currentLevel,
                Math.max(0, client.currentRoomId),
                false,
                client.levelInstanceId
            );
        }
        LevelHandler.setGoblinRiverHostilesUntargetable(client, true);

        if (client.goblinRiverBossIntroUnlockTimer) {
            clearTimeout(client.goblinRiverBossIntroUnlockTimer);
        }

        const levelScope = getClientLevelScope(client);
        const levelName = client.currentLevel;
        client.goblinRiverBossIntroUnlockTimer = setTimeout(() => {
            client.goblinRiverBossIntroUnlockTimer = null;
            if (client.currentLevel !== levelName || getClientLevelScope(client) !== levelScope) {
                client.goblinRiverBossIntroLockUntil = 0;
                return;
            }
            LevelHandler.clearGoblinRiverBossIntroLock(client);
        }, LevelHandler.GOBLIN_RIVER_BOSS_INTRO_DEFAULT_MS);
    }

    private static markRoomEventStarted(client: Client, roomId: number): void {
        if (!client.currentLevel) {
            return;
        }
        client.startedRoomEvents.add(`${client.currentLevel}:${roomId}`);
    }

    private static getMissionState(client: Client, missionId: number): number {
        const missions = client.character?.missions;
        if (!missions || typeof missions !== 'object' || Array.isArray(missions)) {
            return LevelHandler.MISSION_NOT_STARTED;
        }

        const entry = missions[String(missionId)];
        const state = entry && typeof entry === 'object' ? entry.state : undefined;
        return Number(state ?? LevelHandler.MISSION_NOT_STARTED);
    }

    private static hasSavedLevelRecord(client: Client, targetLevel: string): boolean {
        for (const record of [client.character?.CurrentLevel, client.character?.PreviousLevel]) {
            const levelName =
                LevelConfig.normalizeLevelName(record?.name) ||
                String(record?.name ?? '').trim();
            if (levelName === targetLevel) {
                return true;
            }
        }

        return false;
    }

    static isLevelUnlockedForFastTravel(client: Client, targetLevelRaw: string | null | undefined): boolean {
        const targetLevel =
            LevelConfig.normalizeLevelName(targetLevelRaw || '') ||
            String(targetLevelRaw ?? '').trim();
        if (!targetLevel || !LevelConfig.has(targetLevel) || !client.character) {
            return false;
        }

        if (LevelHandler.hasSavedLevelRecord(client, targetLevel)) {
            return true;
        }

        const requirements = LevelHandler.FAST_TRAVEL_AREA_REQUIREMENTS.get(targetLevel);
        if (!requirements) {
            return true;
        }

        return requirements.every((requirement) =>
            LevelHandler.getMissionState(client, requirement.missionId) >= requirement.minState
        );
    }

    private static isDungeonEntryUnlocked(client: Client, _currentLevel: string, targetLevelRaw: string | null): boolean {
        const targetLevel =
            LevelConfig.normalizeLevelName(targetLevelRaw || '') ||
            String(targetLevelRaw || '').trim();
        if (!targetLevel || !LevelConfig.isDungeonLevel(targetLevel)) {
            return true;
        }

        const missionDef = MissionLoader.findPrimaryMissionByDungeon(targetLevel);
        if (!missionDef) {
            return true;
        }

        if (LevelHandler.getMissionState(client, missionDef.MissionID) > LevelHandler.MISSION_NOT_STARTED) {
            return true;
        }

        if (LevelHandler.mustAcceptMissionBeforeDungeonEntry(missionDef.MissionID)) {
            return false;
        }

        return Boolean(client.character && MissionHandler.canStartMission(client.character, missionDef));
    }

    private static mustAcceptMissionBeforeDungeonEntry(missionId: number): boolean {
        return missionId === MissionID.TempleOfShadows ||
            missionId === MissionID.TempleOfShadowsHard ||
            missionId === MissionID.SlayMindlessQueen ||
            missionId === MissionID.SlayMindlessQueenHard ||
            missionId === MissionID.SlayYornak ||
            missionId === MissionID.SlayYornakHard ||
            missionId === MissionID.DerelictionOfDuty ||
            missionId === MissionID.DerelictionOfDutyHard ||
            missionId === MissionID.AbandonedArmory ||
            missionId === MissionID.AbandonedArmoryHard ||
            missionId === MissionID.AncientBurialGrounds ||
            missionId === MissionID.AncientBurialGroundsHard;
    }

    private static getAdditionalDreadfoldGateRequiredMission(currentLevel: string, targetLevel: string): number {
        if (currentLevel === 'JadeCity' && targetLevel === 'JadeCityHard') {
            return MissionID.HeadToValhavenHard;
        }

        return 0;
    }

    private static isReturnToDreadShazariContext(client: Client, targetLevel: string): boolean {
        const previousLevel =
            LevelConfig.normalizeLevelName(client.character?.PreviousLevel?.name) ||
            String(client.character?.PreviousLevel?.name ?? '').trim();
        const entryLevel =
            LevelConfig.normalizeLevelName(client.entryLevel) ||
            String(client.entryLevel ?? '').trim();

        return previousLevel === targetLevel || entryLevel === targetLevel;
    }

    private static isDreadfoldGateUnlocked(
        client: Client,
        currentLevel: string,
        doorId: number,
        targetLevelRaw: string | null
    ): boolean {
        if (doorId !== LevelHandler.DREADFOLD_GATE_DOOR_ID) {
            return true;
        }

        const normalizedCurrentLevel =
            LevelConfig.normalizeLevelName(currentLevel) ||
            String(currentLevel ?? '').trim();
        const targetLevel =
            LevelConfig.normalizeLevelName(targetLevelRaw || '') ||
            String(targetLevelRaw || '').trim();

        if (!LevelHandler.DREADFOLD_ENTRY_TRANSITIONS.has(`${normalizedCurrentLevel}->${targetLevel}`)) {
            return true;
        }

        if (normalizedCurrentLevel === 'ShazariDesert' && targetLevel === 'ShazariDesertHard') {
            return LevelHandler.isReturnToDreadShazariContext(client, targetLevel);
        }

        if (LevelHandler.getMissionState(client, MissionID.Capstone) < LevelHandler.MISSION_CLAIMED) {
            return false;
        }

        const requiredMissionId = LevelHandler.getAdditionalDreadfoldGateRequiredMission(normalizedCurrentLevel, targetLevel);
        return requiredMissionId <= 0 ||
            LevelHandler.getMissionState(client, requiredMissionId) >= LevelHandler.MISSION_CLAIMED;
    }

    private static isDreadfoldGateTransferUnlocked(client: Client, targetLevelRaw: string | null): boolean {
        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character?.CurrentLevel?.name ?? '')) ||
            String(client.currentLevel || client.character?.CurrentLevel?.name || '').trim();

        return LevelHandler.isDreadfoldGateUnlocked(
            client,
            currentLevel,
            LevelHandler.DREADFOLD_GATE_DOOR_ID,
            targetLevelRaw
        );
    }

    private static getStoryAreaEntryRequirementKey(currentLevel: string, targetLevelRaw: string | null): string {
        const normalizedCurrentLevel =
            LevelConfig.normalizeLevelName(currentLevel) ||
            String(currentLevel ?? '').trim();
        const targetLevel =
            LevelConfig.normalizeLevelName(targetLevelRaw || '') ||
            String(targetLevelRaw || '').trim();

        if (!normalizedCurrentLevel || !targetLevel) {
            return '';
        }

        return `${normalizedCurrentLevel}->${targetLevel}`;
    }

    private static getRequiredStoryAreaEntryMission(currentLevel: string, targetLevelRaw: string | null): number {
        const requirementKey = LevelHandler.getStoryAreaEntryRequirementKey(currentLevel, targetLevelRaw);
        if (!requirementKey) {
            return 0;
        }

        return LevelHandler.STORY_AREA_ENTRY_REQUIREMENTS.get(requirementKey) ?? 0;
    }

    private static isStoryAreaEntryUnlocked(client: Client, currentLevel: string, targetLevelRaw: string | null): boolean {
        const requiredMissionId = LevelHandler.getRequiredStoryAreaEntryMission(currentLevel, targetLevelRaw);
        const requirementKey = LevelHandler.getStoryAreaEntryRequirementKey(currentLevel, targetLevelRaw);
        const minState = LevelHandler.STORY_AREA_ENTRY_MIN_STATES.get(requirementKey) ?? LevelHandler.MISSION_CLAIMED;
        return requiredMissionId <= 0 ||
            LevelHandler.getMissionState(client, requiredMissionId) >= minState;
    }

    private static isStoryAreaTransferUnlocked(client: Client, targetLevelRaw: string | null): boolean {
        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character?.CurrentLevel?.name ?? '')) ||
            String(client.currentLevel || client.character?.CurrentLevel?.name || '').trim();

        return LevelHandler.isStoryAreaEntryUnlocked(client, currentLevel, targetLevelRaw);
    }

    private static sendDoorState(client: Client, doorId: number, state: number, targetLevel: string): void {
        const bb = new BitBuffer();
        bb.writeMethod4(doorId);
        bb.writeMethod91(state);
        bb.writeMethod13(targetLevel);
        client.sendBitBuffer(0x42, bb);
    }

    private static sendDoorTarget(client: Client, doorId: number, targetLevel: string): void {
        const bb = new BitBuffer();
        bb.writeMethod4(doorId);
        bb.writeMethod13(targetLevel);
        client.sendBitBuffer(0x2E, bb);
    }

    private static sendLockedDoorThought(client: Client, doorId: number, text: string): void {
        const bb = new BitBuffer();
        const entityId = Number(client.clientEntID) > 0 ? Math.round(Number(client.clientEntID)) : doorId;
        bb.writeMethod4(entityId);
        bb.writeMethod13(LevelHandler.translateDialogueText(client, text));
        client.sendBitBuffer(0x76, bb);
    }

    private static sendDeniedDoorResponse(
        client: Client,
        doorId: number,
        targetLevelRaw: string | null | undefined,
        text: string,
        clearDoorTransferState: boolean = false
    ): void {
        const targetLevel = LevelConfig.normalizeLevelName(targetLevelRaw) || String(targetLevelRaw ?? '').trim();
        if (Number.isFinite(Number(doorId)) && Number(doorId) >= 0 && targetLevel) {
            LevelHandler.sendDoorState(client, Math.round(Number(doorId)), LevelHandler.DOORSTATE_LOCKED, targetLevel);
        }

        LevelHandler.sendLockedDoorThought(client, doorId, text);

        if (clearDoorTransferState) {
            client.lastDoorId = -1;
            client.lastDoorTargetLevel = '';
            client.mountTransferGraceUntil = 0;
        }
    }

    private static resolveKeepTutorialTransferTarget(client: Client, targetLevel: string): string {
        if (
            targetLevel === 'CraftTown' &&
            LevelHandler.getMissionState(client, LevelHandler.FIRST_KEEP_MISSION_ID) ===
                LevelHandler.MISSION_IN_PROGRESS
        ) {
            return 'CraftTownTutorial';
        }

        return targetLevel;
    }

    private static resolveDoorTarget(client: Client, currentLevel: string, doorId: number): string | null {
        if (doorId === 999 && currentLevel === 'CraftTown') {
            if (
                LevelHandler.getMissionState(client, LevelHandler.FIRST_KEEP_MISSION_ID) ===
                LevelHandler.MISSION_IN_PROGRESS
            ) {
                return 'CraftTownTutorial';
            }

            return LevelHandler.resolveCraftTownReturnLevel(
                client,
                client.character,
                currentLevel,
                null
            );
        }

        if (doorId === 0 && (currentLevel === 'CraftTown' || currentLevel === 'CraftTownTutorial')) {
            return LevelHandler.resolveCraftTownReturnLevel(
                client,
                client.character,
                currentLevel,
                null
            );
        }

        const arachnaeConnectorTarget = LevelHandler.resolveArachnaeConnectorDoorTarget(client, currentLevel, doorId);
        if (arachnaeConnectorTarget) {
            return arachnaeConnectorTarget;
        }

        const castleHockeGatewayTarget = LevelHandler.resolveCastleHockeGatewayDoorTarget(client, currentLevel, doorId);
        if (castleHockeGatewayTarget) {
            return castleHockeGatewayTarget;
        }

        const valhavenGatewayTarget = LevelHandler.resolveValhavenGatewayDoorTarget(client, currentLevel, doorId);
        if (valhavenGatewayTarget) {
            return valhavenGatewayTarget;
        }

        return LevelConfig.getDoorTarget(currentLevel, doorId);
    }

    private static resolveCastleHockeGatewayDoorTarget(client: Client, currentLevel: string, doorId: number): string | null {
        if (doorId !== LevelHandler.CASTLE_HOCKE_GATE_DOOR_ID) {
            return null;
        }

        if (
            currentLevel === 'BridgeTown' &&
            LevelHandler.getMissionState(client, MissionID.DeepgardDragon) >= LevelHandler.MISSION_READY_TO_TURN_IN
        ) {
            return 'Castle';
        }

        if (
            currentLevel === 'BridgeTownHard' &&
            LevelHandler.getMissionState(client, MissionID.DeepgardDragonHard) >= LevelHandler.MISSION_READY_TO_TURN_IN
        ) {
            return 'CastleHard';
        }

        return null;
    }

    private static resolveValhavenGatewayDoorTarget(client: Client, currentLevel: string, doorId: number): string | null {
        if (doorId !== LevelHandler.VALHAVEN_GATE_DOOR_ID) {
            return null;
        }

        if (
            currentLevel === 'ShazariDesert' &&
            LevelHandler.getMissionState(client, MissionID.HeadToValhaven) >= LevelHandler.MISSION_READY_TO_TURN_IN
        ) {
            return 'JadeCity';
        }

        if (
            currentLevel === 'ShazariDesertHard' &&
            LevelHandler.getMissionState(client, MissionID.HeadToValhavenHard) >= LevelHandler.MISSION_READY_TO_TURN_IN
        ) {
            return 'JadeCityHard';
        }

        return null;
    }

    private static resolveArachnaeConnectorDoorTarget(client: Client, currentLevel: string, doorId: number): string | null {
        if (doorId !== 1) {
            return null;
        }

        if (currentLevel === 'BridgeTown' || currentLevel === 'SwampRoadNorth') {
            return LevelHandler.getMissionState(client, MissionID.ClearTheBridge) >= LevelHandler.MISSION_READY_TO_TURN_IN
                ? 'SwampRoadConnection'
                : null;
        }

        if (currentLevel === 'BridgeTownHard' || currentLevel === 'SwampRoadNorthHard') {
            return LevelHandler.getMissionState(client, MissionID.ClearTheBridgeHard) >= LevelHandler.MISSION_READY_TO_TURN_IN
                ? 'SwampRoadConnectionHard'
                : null;
        }

        return null;
    }

    private static hasRoomEventStarted(client: Client, roomId: number): boolean {
        if (!client.currentLevel) {
            return false;
        }
        return client.startedRoomEvents.has(`${client.currentLevel}:${roomId}`);
    }

    private static storePendingTransferToken(
        token: number,
        character: any,
        userId: number | null,
        targetLevel: string,
        previousLevel: string,
        newX: number,
        newY: number,
        newHasCoord: boolean,
        sendExtended: boolean,
        syncState: LevelSyncState | null = null,
        doorContext: DoorTravelContext | null = null,
        craftTownHostCharacter?: Character,
        playSessionStartedAt?: number
    ): void {
        const shouldSyncDungeonProgress = LevelConfig.isDungeonLevel(targetLevel);
        const craftTownHomeInstanceId = targetLevel === 'CraftTown'
            ? getCraftTownHomeInstanceId(character, craftTownHostCharacter)
            : '';
        const levelInstanceId = shouldSyncDungeonProgress
            ? normalizeLevelInstanceId(syncState?.levelInstanceId) || createDungeonInstanceId(token)
            : craftTownHomeInstanceId;
        const syncAnchorStartedAt = shouldSyncDungeonProgress
            ? LevelHandler.normalizeSyncAnchorStartedAt(syncState?.syncAnchorStartedAt) ?? Date.now()
            : undefined;
        const syncAnchorToken = shouldSyncDungeonProgress
            ? (Number(syncState?.syncAnchorToken ?? 0) > 0 ? Math.round(Number(syncState?.syncAnchorToken)) : token)
            : (Number(syncState?.syncAnchorToken ?? 0) > 0 ? Math.round(Number(syncState?.syncAnchorToken)) : undefined);
        const syncAnchorCharacterName = shouldSyncDungeonProgress
            ? String(syncState?.syncAnchorCharacterName ?? character?.name ?? '').trim() || undefined
            : String(syncState?.syncAnchorCharacterName ?? '').trim() || undefined;

        if (userId) {
            GlobalState.pendingWorld.set(token, {
                character,
                craftTownHostCharacter,
                userId,
                targetLevel,
                levelInstanceId: levelInstanceId || undefined,
                previousLevel,
                newX,
                newY,
                newHasCoord,
                syncAnchorStartedAt,
                syncAnchorToken,
                syncAnchorCharacterName,
                syncEntryLevel: syncState?.syncEntryLevel,
                syncEntryX: syncState?.syncEntryHasCoord ? Math.round(Number(syncState.syncEntryX ?? 0)) : undefined,
                syncEntryY: syncState?.syncEntryHasCoord ? Math.round(Number(syncState.syncEntryY ?? 0)) : undefined,
                syncEntryHasCoord: Boolean(syncState?.syncEntryHasCoord),
                syncRoomId: syncState?.syncRoomId,
                syncStartedRoomIds: syncState?.syncStartedRoomIds,
                syncQuestProgress: syncState?.syncQuestProgress,
                sourceDoorId: doorContext?.sourceDoorId,
                sourceDoorLevel: doorContext?.sourceLevel,
                sourceDoorTargetLevel: doorContext?.targetLevel,
                playSessionStartedAt: Number.isFinite(Number(playSessionStartedAt ?? syncState?.playSessionStartedAt)) &&
                    Number(playSessionStartedAt ?? syncState?.playSessionStartedAt) > 0
                    ? Math.round(Number(playSessionStartedAt ?? syncState?.playSessionStartedAt))
                    : undefined
            });
            GlobalState.tokenChar.set(token, {
                character,
                userId
            });
        }

        GlobalState.pendingExtended.set(token, sendExtended);
    }

    private static shouldSendExtendedOnTransfer(targetLevel: string): boolean {
        return false;
    }

    private static isDifferentCharacter(left: Character | null | undefined, right: Character | null | undefined): boolean {
        const leftKey = normalizeCharacterKey(left?.name);
        const rightKey = normalizeCharacterKey(right?.name);
        return Boolean(leftKey && rightKey && leftKey !== rightKey);
    }

    private static resolveVisitedCraftTownHostCharacter(
        client: Client,
        transferToken: number,
        activeCharacter: Character,
        targetLevel: string
    ): Character {
        if (targetLevel !== 'CraftTown') {
            return activeCharacter;
        }

        const queuedHost = GlobalState.houseVisits.get(transferToken);
        if (queuedHost) {
            GlobalState.houseVisits.delete(transferToken); // Consume
            if (LevelHandler.isDifferentCharacter(activeCharacter, queuedHost)) {
                client.craftTownHostCharacter = queuedHost;
                console.log(`[Level] House Visit active! Host: ${queuedHost.name}`);
                return queuedHost;
            }

            client.craftTownHostCharacter = null;
            return activeCharacter;
        }

        if (LevelHandler.isDifferentCharacter(activeCharacter, client.craftTownHostCharacter)) {
            console.log(`[Level] House Visit active from session host! Host: ${client.craftTownHostCharacter!.name}`);
            return client.craftTownHostCharacter!;
        }

        client.craftTownHostCharacter = null;
        return activeCharacter;
    }

    private static allocateTransferToken(targetLevel: string): number {
        return TransferTokenAllocator.allocate(targetLevel);
    }

    private static resolveVisitedCraftTownOwnerToken(transferToken: number, hostCharacter: Character | null | undefined): number | undefined {
        if (!hostCharacter) {
            return undefined;
        }

        const hostSession = GlobalState.getActiveSessionByCharacterName(hostCharacter.name);
        const hostToken = Math.round(Number(hostSession?.token ?? 0));
        if (Number.isFinite(hostToken) && hostToken > 0 && hostToken !== transferToken) {
            return hostToken;
        }

        const fallbackToken = transferToken >= 0xFFFF ? 1 : transferToken + 1;
        return fallbackToken !== transferToken ? fallbackToken : 1;
    }

    private static rememberTransferTokenAlias(sourceToken: number, targetToken: number): void {
        if (!Number.isFinite(sourceToken) || !Number.isFinite(targetToken)) {
            return;
        }
        if (sourceToken <= 0 || targetToken <= 0 || sourceToken === targetToken) {
            return;
        }

        GlobalState.transferTokenAliases.set(sourceToken, targetToken);
    }

    private static resolveTransferTokenAlias(token: number): number {
        let resolvedToken = token;
        const visitedTokens = new Set<number>([resolvedToken]);

        while (true) {
            const nextToken = GlobalState.transferTokenAliases.get(resolvedToken);
            if (!nextToken || nextToken <= 0 || visitedTokens.has(nextToken)) {
                return resolvedToken;
            }

            resolvedToken = nextToken;
            visitedTokens.add(resolvedToken);
        }
    }

    private static recoverTransferSessionStateFromExactToken(
        client: Client,
        token: number
    ): { resolvedToken: number; source: string } | null {
        const activeSession = GlobalState.sessionsByToken.get(token);
        if (activeSession?.character) {
            LevelHandler.cloneTransferGameplayState(client, activeSession);
            console.log(
                `[Level] Recovered transfer session from active token ${token} for user ${client.userId} (Char: ${activeSession.character.name})`
            );
            return {
                resolvedToken: activeSession.token > 0 ? activeSession.token : token,
                source: 'active-token'
            };
        }

        const usedEntry = GlobalState.usedTransferTokens.get(token);
        if (usedEntry) {
            const liveSession = LevelHandler.findActiveTransferSession(usedEntry.userId, usedEntry.character?.name);
            if (liveSession?.character) {
                LevelHandler.cloneTransferGameplayState(client, liveSession);
                console.log(
                    `[Level] Recovered transfer session from used token ${token} via active token ${liveSession.token} for user ${client.userId} (Char: ${liveSession.character.name})`
                );
                return {
                    resolvedToken: liveSession.token > 0 ? liveSession.token : token,
                    source: 'used-token-live-session'
                };
            }

            client.character = usedEntry.character;
            client.userId = usedEntry.userId;
            client.currentLevel = usedEntry.targetLevel;
            client.craftTownHostCharacter = usedEntry.targetLevel === 'CraftTown'
                ? usedEntry.craftTownHostCharacter ?? null
                : null;
            client.levelInstanceId = normalizeLevelInstanceId(usedEntry.levelInstanceId);
            client.entryLevel = LevelConfig.resolveDungeonEntryLevel(
                usedEntry.targetLevel,
                usedEntry.previousLevel,
                usedEntry.character
            );
            const usedEntryCoords = Boolean(usedEntry.syncEntryHasCoord)
                && Number.isFinite(Number(usedEntry.syncEntryX))
                && Number.isFinite(Number(usedEntry.syncEntryY))
                ? {
                    x: Math.round(Number(usedEntry.syncEntryX)),
                    y: Math.round(Number(usedEntry.syncEntryY)),
                    hasCoord: true
                }
                : LevelConfig.resolveDungeonEntryCoordinates(
                    usedEntry.targetLevel,
                    usedEntry.previousLevel,
                    usedEntry.character
                );
            client.entryX = usedEntryCoords.x;
            client.entryY = usedEntryCoords.y;
            client.entryHasCoord = usedEntryCoords.hasCoord;
            client.syncAnchorStartedAt = LevelHandler.normalizeSyncAnchorStartedAt(usedEntry.syncAnchorStartedAt) ?? 0;
            client.syncAnchorToken = Number(usedEntry.syncAnchorToken ?? 0) > 0 ? Math.round(Number(usedEntry.syncAnchorToken)) : 0;
            client.syncAnchorCharacterName = String(usedEntry.syncAnchorCharacterName ?? '').trim();
            client.syncQuestProgress = LevelHandler.normalizeQuestProgress(usedEntry.syncQuestProgress);
            client.lastDoorId = Number.isFinite(Number(usedEntry.sourceDoorId))
                ? Math.round(Number(usedEntry.sourceDoorId))
                : -1;
            client.lastDoorTargetLevel = LevelConfig.normalizeLevelName(usedEntry.sourceDoorTargetLevel) || '';
            LevelHandler.applyStoredRoomProgressState(
                client,
                usedEntry.targetLevel,
                usedEntry.syncRoomId,
                usedEntry.syncStartedRoomIds
            );
            console.log(
                `[Level] Recovered transfer session from used token ${token} for user ${client.userId} (Char: ${client.character.name})`
            );
            return {
                resolvedToken: token,
                source: 'used-token'
            };
        }

        const tokenInfo = GlobalState.tokenChar.get(token);
        if (tokenInfo) {
            client.character = tokenInfo.character;
            client.userId = tokenInfo.userId;
            const liveSession = LevelHandler.findActiveTransferSession(tokenInfo.userId, tokenInfo.character?.name);
            if (liveSession?.character) {
                LevelHandler.cloneTransferGameplayState(client, liveSession);
                console.log(
                    `[Level] Recovered transfer session from tokenChar ${token} via active token ${liveSession.token} for user ${client.userId} (Char: ${client.character.name})`
                );
                return {
                    resolvedToken: liveSession.token > 0 ? liveSession.token : token,
                    source: 'token-char-live-session'
                };
            }

            console.log(
                `[Level] Recovered transfer session from tokenChar ${token} for user ${client.userId} (Char: ${client.character.name})`
            );
            return {
                resolvedToken: token,
                source: 'token-char'
            };
        }

        const pendingEntry = GlobalState.pendingWorld.get(token);
        if (pendingEntry) {
            client.character = pendingEntry.character;
            client.userId = pendingEntry.userId;
            client.currentLevel = pendingEntry.targetLevel;
            client.craftTownHostCharacter = pendingEntry.targetLevel === 'CraftTown'
                ? pendingEntry.craftTownHostCharacter ?? null
                : null;
            client.levelInstanceId = normalizeLevelInstanceId(pendingEntry.levelInstanceId);
            client.entryLevel = LevelConfig.resolveDungeonEntryLevel(
                pendingEntry.targetLevel,
                pendingEntry.previousLevel,
                pendingEntry.character
            );
            const pendingEntryCoords = Boolean(pendingEntry.syncEntryHasCoord)
                && Number.isFinite(Number(pendingEntry.syncEntryX))
                && Number.isFinite(Number(pendingEntry.syncEntryY))
                ? {
                    x: Math.round(Number(pendingEntry.syncEntryX)),
                    y: Math.round(Number(pendingEntry.syncEntryY)),
                    hasCoord: true
                }
                : LevelConfig.resolveDungeonEntryCoordinates(
                    pendingEntry.targetLevel,
                    pendingEntry.previousLevel,
                    pendingEntry.character
                );
            client.entryX = pendingEntryCoords.x;
            client.entryY = pendingEntryCoords.y;
            client.entryHasCoord = pendingEntryCoords.hasCoord;
            client.syncAnchorStartedAt = LevelHandler.normalizeSyncAnchorStartedAt(pendingEntry.syncAnchorStartedAt) ?? 0;
            client.syncAnchorToken = Number(pendingEntry.syncAnchorToken ?? 0) > 0 ? Math.round(Number(pendingEntry.syncAnchorToken)) : 0;
            client.syncAnchorCharacterName = String(pendingEntry.syncAnchorCharacterName ?? '').trim();
            client.syncQuestProgress = LevelHandler.normalizeQuestProgress(pendingEntry.syncQuestProgress);
            client.lastDoorId = Number.isFinite(Number(pendingEntry.sourceDoorId))
                ? Math.round(Number(pendingEntry.sourceDoorId))
                : -1;
            client.lastDoorTargetLevel = LevelConfig.normalizeLevelName(pendingEntry.sourceDoorTargetLevel) || '';
            LevelHandler.applyStoredRoomProgressState(
                client,
                pendingEntry.targetLevel,
                pendingEntry.syncRoomId,
                pendingEntry.syncStartedRoomIds
            );
            console.log(
                `[Level] Recovered transfer session from pendingWorld ${token} for user ${client.userId} (Char: ${client.character.name})`
            );
            return {
                resolvedToken: token,
                source: 'pending-world'
            };
        }

        return null;
    }

    private static recoverTransferSessionState(
        client: Client,
        token: number
    ): { resolvedToken: number; source: string } | null {
        if (client.character) {
            return {
                resolvedToken: client.token > 0 ? client.token : token,
                source: 'client'
            };
        }

        const directState = LevelHandler.recoverTransferSessionStateFromExactToken(client, token);
        if (directState) {
            return directState;
        }

        const aliasedToken = LevelHandler.resolveTransferTokenAlias(token);
        if (aliasedToken === token) {
            return null;
        }

        const aliasedState = LevelHandler.recoverTransferSessionStateFromExactToken(client, aliasedToken);
        if (!aliasedState) {
            return null;
        }

        console.log(`[Level] Recovered transfer session from aliased token ${token} -> ${aliasedToken}`);
        return {
            resolvedToken: aliasedState.resolvedToken,
            source: `alias:${token}->${aliasedToken}:${aliasedState.source}`
        };
    }

    static sendRoomEventStart(client: Client, roomId: number, flag: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod9(roomId);
        bb.writeMethod15(flag);
        client.sendBitBuffer(0xA5, bb);
        LevelHandler.markRoomEventStarted(client, roomId);
    }

    static primeTutorialRoomEvents(client: Client): void {
        if (!['TutorialBoat', 'TutorialDungeon', 'CraftTownTutorial'].includes(client.currentLevel)) {
            return;
        }
        if (LevelHandler.getStartedRoomIdsForLevel(client, client.currentLevel).length > 0) {
            return;
        }

        const initialRoomIds = [0, 1];

        for (const roomId of initialRoomIds) {
            if (!LevelHandler.hasRoomEventStarted(client, roomId)) {
                LevelHandler.sendRoomEventStart(client, roomId, true);
            }
        }

    }

    static restoreTransferredRoomProgress(
        client: Client,
        entry: { targetLevel: string; syncRoomId?: number; syncStartedRoomIds?: number[] }
    ): boolean {
        return LevelHandler.applyStoredRoomProgressState(
            client,
            entry.targetLevel,
            entry.syncRoomId,
            entry.syncStartedRoomIds,
            true
        );
    }

    static handleRequestDoorState(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const doorId = br.readMethod9();
        
        // Lookup door target in LevelConfig
        const currentLevel = client.currentLevel || "NewbieRoad";
        const target = LevelHandler.resolveDoorTarget(client, currentLevel, doorId);
        const isDungeonEntryUnlocked = LevelHandler.isDungeonEntryUnlocked(client, currentLevel, target);
        const isDreadfoldGateLocked =
            Boolean(target) &&
            !LevelHandler.isDreadfoldGateUnlocked(client, currentLevel, doorId, target);
        const isStoryAreaEntryLocked =
            Boolean(target) &&
            !LevelHandler.isStoryAreaEntryUnlocked(client, currentLevel, target);
        
        const bb = new BitBuffer();
        bb.writeMethod4(doorId);
        
        if (target && isDreadfoldGateLocked) {
            bb.writeMethod91(LevelHandler.DOORSTATE_LOCKED);
            bb.writeMethod13(target);
        } else if (target && isStoryAreaEntryLocked) {
            bb.writeMethod91(LevelHandler.DOORSTATE_LOCKED);
            bb.writeMethod13(target);
        } else if (target && !isDungeonEntryUnlocked) {
            bb.writeMethod91(LevelHandler.DOORSTATE_LOCKED);
            bb.writeMethod13(target);
        } else if (target) {
            const completedStars = LevelHandler.getCompletedDungeonDoorStars(client, target);
            let doorState: number;
            if (completedStars > 0) {
                doorState = LevelHandler.DOORSTATE_MISSIONREPEAT;
            } else if (LevelConfig.isDungeonLevel(target)) {
                doorState = LevelHandler.DOORSTATE_DUNGEON;
            } else {
                doorState = LevelHandler.DOORSTATE_STATIC;
            }
            bb.writeMethod91(doorState);
            bb.writeMethod13(target);
            if (doorState === LevelHandler.DOORSTATE_MISSIONREPEAT) {
                bb.writeMethod6(completedStars, 4);
            }
        } else {
            bb.writeMethod91(LevelHandler.DOORSTATE_CLOSED);
            bb.writeMethod13("");
        }

        client.sendBitBuffer(0x42, bb);
    }

    private static getCompletedDungeonDoorStars(client: Client, targetLevelRaw: string | null | undefined): number {
        const targetLevel = LevelConfig.normalizeLevelName(targetLevelRaw);
        if (!targetLevel || !client.character) {
            return 0;
        }

        const missionDef = MissionLoader.findPrimaryMissionByDungeon(targetLevel);
        if (!missionDef) {
            return 0;
        }

        const missionEntry = client.character.missions?.[String(missionDef.MissionID)];
        if (!missionEntry || Number(missionEntry.state ?? 0) < 2) {
            return 0;
        }

        return Math.max(1, Math.min(15, Math.round(Number(missionEntry.Tier ?? 0)) || 1));
    }

    static spawnLevelNpcs(client: Client, levelName: string): void {
        EntityHandler.sendInitialLevelEntities(client, levelName);
    }

    // 0x2D: Open Door
    static handleOpenDoor(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const doorId = br.readMethod9();

        const currentLevel = LevelConfig.normalizeLevelName(client.currentLevel || "NewbieRoad") || "NewbieRoad";
        const rawTargetLevel = LevelHandler.resolveDoorTarget(client, currentLevel, doorId);
        let targetLevel = LevelConfig.normalizeLevelName(rawTargetLevel);

        if (
            rawTargetLevel &&
            !LevelHandler.isDreadfoldGateUnlocked(client, currentLevel, doorId, rawTargetLevel)
        ) {
            console.log(`[Level] Open Door ${doorId} in ${currentLevel} blocked until Capstone is completed`);
            LevelHandler.sendDeniedDoorResponse(client, doorId, rawTargetLevel, LevelHandler.DREADFOLD_GATE_LOCKED_MESSAGE, true);
            return;
        }

        if (
            rawTargetLevel &&
            !LevelHandler.isStoryAreaEntryUnlocked(client, currentLevel, rawTargetLevel)
        ) {
            console.log(`[Level] Open Door ${doorId} in ${currentLevel} blocked until the required story area mission state is reached`);
            LevelHandler.sendDeniedDoorResponse(client, doorId, rawTargetLevel, LevelHandler.LOCKED_STORY_AREA_ENTRY_MESSAGE, true);
            return;
        }

        if (
            rawTargetLevel &&
            !LevelHandler.isDungeonEntryUnlocked(client, currentLevel, rawTargetLevel)
        ) {
            console.log(`[Level] Open Door ${doorId} in ${currentLevel} blocked until the matching dungeon quest is accepted`);
            LevelHandler.sendDeniedDoorResponse(client, doorId, rawTargetLevel, LevelHandler.LOCKED_DUNGEON_ENTRY_MESSAGE, true);
            return;
        }

        if (!targetLevel && doorId === 999) {
            targetLevel = "CraftTown";
        }

        if (!targetLevel && LevelConfig.isDungeonLevel(currentLevel)) {
            targetLevel = LevelConfig.resolveDungeonEntryLevel(currentLevel, client.entryLevel, client.character);
        }

        if (!targetLevel) {
            targetLevel = currentLevel;
        }

        console.log(`[Level] Open Door ${doorId} in ${currentLevel} -> ${targetLevel}`);

        // Send 0x2E Door Target
        if (targetLevel) {
            client.lastDoorId = doorId;
            client.lastDoorTargetLevel = targetLevel;
            client.armPendingTransferGrace();
            PetHandler.armMountTravelProtection(client, 5000, false);
            const bb = new BitBuffer();
            bb.writeMethod4(doorId);
            bb.writeMethod13(targetLevel);
            client.sendBitBuffer(0x2E, bb);
        }
    }

    static async handleQuestProgressUpdate(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const requestedProgress = br.readMethod4();
        const previousProgress = Number(client.character?.questTrackerState ?? 0);
        let progress = requestedProgress;
        const currentLevel = LevelConfig.normalizeLevelName(
            client.currentLevel || String(client.character?.CurrentLevel?.name ?? '')
        );

        if (currentLevel === 'CraftTown' && previousProgress >= 100 && requestedProgress < 100) {
            progress = previousProgress;
        }

        if (currentLevel === 'TutorialDungeon' && LevelHandler.shouldClampTutorialDungeonToIntroProgress(client)) {
            progress = LevelHandler.TUTORIAL_DUNGEON_INITIAL_PROGRESS;
        }

        const levelScope = getClientLevelScope(client);
        if (usesSharedDungeonProgress(currentLevel) && levelScope) {
            const sharedState = recomputeSharedDungeonProgress(levelScope);
            if (sharedState) {
                const liveAuthorityToken = resolveSharedDungeonProgressAuthorityToken(levelScope);
                if (liveAuthorityToken > 0) {
                    sharedState.authorityToken = liveAuthorityToken;
                }
                progress = sharedState.progress;
            } else {
                progress = getSharedDungeonInitialProgress(currentLevel);
            }
        }

        if (client.character) {
            client.character.questTrackerState = progress;
        }
        noteDungeonRunCompletionProgress(client, progress);
        MissionHandler.maybeScheduleFullClearDungeonCompletionFromProgress(client, progress);

        DebugLogger.logProgress('QuestProgress:update', client, client.character, {
            previousProgress,
            requestedProgress,
            progress
        });

        if (client.character && client.userId && progress !== previousProgress) {
            if (typeof client.scheduleCharacterSave === 'function') {
                LevelHandler.scheduleCurrentCharacterSnapshot(client, 'quest progress update');
            } else {
                await LevelHandler.saveCurrentCharacterSnapshot(client);
            }
            DebugLogger.logProgress('QuestProgress:saveQueued', client, client.character, {
                previousProgress,
                progress
            });
        }

        if (usesSharedDungeonProgress(currentLevel) && levelScope) {
            LevelHandler.broadcastSharedDungeonQuestProgress(levelScope, progress);
            return;
        }

        LevelHandler.relayToLevel(client, 0xB7, data);
    }

    static handlePlaySound(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const roomId = br.readMethod9();
        LevelHandler.cacheRoomId(client, roomId);
        br.readMethod26();
        br.readMethod9();

        LevelHandler.relayToLevel(client, 0xA8, data);
    }

    static handleActionUpdate(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const roomId = br.readMethod9();
        LevelHandler.cacheRoomId(client, roomId);
        br.readMethod9();

        LevelHandler.relayToLevel(client, 0xAA, data);
    }

    static handleRoomStateUpdate(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const roomId = br.readMethod9();
        LevelHandler.cacheRoomId(client, roomId);
        br.readMethod9();

        LevelHandler.relayToLevel(client, 0xA9, data);
    }

    static handleRoomEventStart(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const roomId = br.readMethod9();
        LevelHandler.cacheRoomId(client, roomId);
        br.readMethod15();
        LevelHandler.markRoomEventStarted(client, roomId);

        LevelHandler.relayToLevel(client, 0xA5, data);
        for (const other of LevelHandler.forLevelRecipients(client, true)) {
            MissionHandler.noteDungeonCutsceneStart(other, roomId);
        }
    }

    static handleRoomInfoUpdate(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const roomId = br.readMethod9();
        LevelHandler.cacheRoomId(client, roomId);
        br.readMethod9();
        br.readMethod26();
        br.readMethod9();
        br.readMethod26();

        LevelHandler.relayToLevel(client, 0xAB, data);
    }

    static handleRoomClose(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const roomId = br.readMethod9();
        LevelHandler.cacheRoomId(client, roomId);

        LevelHandler.relayToLevel(client, 0xA6, data);
        for (const other of LevelHandler.forLevelRecipients(client, true)) {
            MissionHandler.noteDungeonCutsceneEnd(other, roomId);
        }
    }

    static handleRoomUnlock(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const roomId = br.readMethod9();
        LevelHandler.cacheRoomId(client, roomId);

        LevelHandler.relayToLevel(client, 0xAD, data);
    }

    static handleRoomBossInfo(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const roomId = br.readMethod9();
        LevelHandler.cacheRoomId(client, roomId);
        const bossId = br.readMethod9();
        const bossName = br.readMethod26();
        br.readMethod9();
        br.readMethod26();
        for (const other of LevelHandler.forLevelRecipients(client, true)) {
            MissionHandler.noteDungeonCutsceneStart(other, roomId);
        }
        const levelScope = getClientLevelScope(client);
        markRoomBossEntity(levelScope, bossId, roomId, bossName);
        noteDungeonRunBossCutscene(levelScope, roomId, bossId);

        LevelHandler.relayToLevel(client, 0xAC, data);
    }

    static handleSetUntargetable(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        br.readMethod4();
        br.readMethod15();

        LevelHandler.relayToLevel(client, 0xAE, data);
    }

    static handleChangeMaxSpeed(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const entityId = br.readMethod4();
        const speedScaled = br.readMethod4();
        const behaviorSpeedMod = speedScaled / 10000;

        const entity = client.entities.get(entityId);
        if (entity) {
            entity.behaviorSpeedMod = behaviorSpeedMod;
        }

        if (client.currentLevel) {
            const levelEntity = LevelHandler.getCurrentLevelMap(client)?.get(entityId);
            if (levelEntity) {
                levelEntity.behaviorSpeedMod = behaviorSpeedMod;
            }
        }

        LevelHandler.relayToLevel(client, 0x8A, data);
    }

    static handleChangeOffsetY(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const entityId = br.readMethod4();
        const offsetY = br.readMethod739();

        const entity = client.entities.get(entityId);
        if (entity) {
            entity.renderDepthOffset = offsetY;
            entity.targetOffsetY = offsetY;
        }

        LevelHandler.relayToLevel(client, 0x7D, data);
    }

    // 0x1D: Level Transfer Request
    static async handleLevelTransferRequest(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const packetToken = br.readMethod9();
        const requestedLevelRaw = br.readMethod13();
        const requestedLevel = LevelConfig.normalizeLevelName(requestedLevelRaw);

        console.log(`[Level] Transfer Request (0x1D): Token=${packetToken}, Level=${requestedLevelRaw}`);

        // Safety: ensure client is authenticated or token matches
        const transferState = LevelHandler.recoverTransferSessionState(client, packetToken);
        if (!transferState) {
             console.error(`[Level] No character on session during transfer request. Token=${packetToken} was not recoverable.`);
             console.log(`[Level] Available tokenChar tokens: ${Array.from(GlobalState.tokenChar.keys()).join(", ")}`);
             console.log(`[Level] Available used tokens: ${Array.from(GlobalState.usedTransferTokens.keys()).join(", ")}`);
             console.log(`[Level] Available session tokens: ${Array.from(GlobalState.sessionsByToken.keys()).join(", ")}`);
             return;
        }

        const transferToken = transferState.resolvedToken;
        if (transferToken !== packetToken) {
            console.log(`[Level] Remapped transfer token ${packetToken} -> active token ${transferToken} (${transferState.source})`);
        }

        const lastDoorTarget = LevelConfig.normalizeLevelName(client.lastDoorTargetLevel);
        const teleportOverride = GlobalState.pendingTeleports.get(transferToken);
        if (teleportOverride) {
            GlobalState.pendingTeleports.delete(transferToken);
        }

        // 1. Determine Target Level
        let targetLevel = requestedLevel;
        const teleportTargetLevel = LevelConfig.normalizeLevelName(teleportOverride?.targetLevel);

        if (teleportTargetLevel && LevelConfig.has(teleportTargetLevel)) {
            targetLevel = teleportTargetLevel;
        } else if (!targetLevel || targetLevel === "None") {
            if (lastDoorTarget && LevelConfig.has(lastDoorTarget)) {
                targetLevel = lastDoorTarget;
                console.log(`[Level] Using last door target for transfer: ${targetLevel}`);
            } else {
                targetLevel = "NewbieRoad";
            }
        } else if (
            lastDoorTarget &&
            LevelConfig.has(lastDoorTarget) &&
            targetLevel === LevelConfig.normalizeLevelName(client.currentLevel) &&
            lastDoorTarget !== targetLevel
        ) {
            console.log(
                `[Level] Client requested current level '${targetLevel}' after door ${client.lastDoorId}; using last door target ${lastDoorTarget}`
            );
            targetLevel = lastDoorTarget;
        } else if (!LevelConfig.has(targetLevel) && lastDoorTarget && LevelConfig.has(lastDoorTarget)) {
            console.log(`[Level] Invalid transfer target '${targetLevel}', falling back to last door target ${lastDoorTarget}`);
            targetLevel = lastDoorTarget;
        }

        targetLevel = LevelHandler.resolveKeepTutorialTransferTarget(client, targetLevel);

        if (!LevelConfig.has(targetLevel)) {
            const safeFallback = LevelConfig.normalizeLevelName(client.currentLevel || "NewbieRoad") || "NewbieRoad";
            console.log(`[Level] Unresolved transfer target '${targetLevel}', staying in ${safeFallback}`);
            targetLevel = safeFallback;
        }

        if (!teleportOverride && !LevelHandler.isDreadfoldGateTransferUnlocked(client, targetLevel)) {
            console.log(`[Level] Transfer to ${targetLevel} blocked until Capstone is completed`);
            LevelHandler.sendDeniedDoorResponse(
                client,
                client.lastDoorId,
                targetLevel,
                LevelHandler.DREADFOLD_GATE_LOCKED_MESSAGE,
                true
            );
            return;
        }

        if (!teleportOverride && !LevelHandler.isStoryAreaTransferUnlocked(client, targetLevel)) {
            console.log(`[Level] Transfer to ${targetLevel} blocked until the required story area mission state is reached`);
            LevelHandler.sendDeniedDoorResponse(
                client,
                client.lastDoorId,
                targetLevel,
                LevelHandler.LOCKED_STORY_AREA_ENTRY_MESSAGE,
                true
            );
            return;
        }

        if (!teleportOverride && !LevelHandler.isDungeonEntryUnlocked(client, client.currentLevel || '', targetLevel)) {
            console.log(`[Level] Transfer to ${targetLevel} blocked until the matching dungeon quest is accepted`);
            LevelHandler.sendDeniedDoorResponse(
                client,
                client.lastDoorId,
                targetLevel,
                LevelHandler.LOCKED_DUNGEON_ENTRY_MESSAGE,
                true
            );
            return;
        }

        const doorContext = LevelHandler.getActiveDoorTravelContext(client, targetLevel);
        const syncState = LevelHandler.buildTransferSyncState(client, targetLevel, teleportOverride ?? null);

        DebugLogger.logProgress('LevelTransfer:beforeSave', client, client.character, {
            packetToken,
            targetLevel
        });
        await LevelHandler.saveCurrentCharacterSnapshot(client);
        await LevelHandler.refreshCurrentCharacterFromSave(client);
        DebugLogger.logProgress('LevelTransfer:afterReload', client, client.character, {
            packetToken,
            targetLevel
        });

        const activeCharacter = client.character;
        if (!activeCharacter) {
            console.error(`[Level] Character state disappeared during transfer. Token=${packetToken}`);
            return;
        }
        if (targetLevel === 'CraftTown' && teleportOverride?.craftTownHostCharacter) {
            client.craftTownHostCharacter = teleportOverride.craftTownHostCharacter;
        }

        const oldLevel = LevelHandler.resolveTransferSourceLevel(client, activeCharacter);
        const ent = client.entities.get(client.clientEntID);
        let oldX = 0, oldY = 0;
        let hasOldCoord = false;

        if (ent) {
            oldX = ent.x;
            oldY = ent.y;
            hasOldCoord = Number.isFinite(oldX) && Number.isFinite(oldY);
        }

        LevelHandler.syncTransferSourcePositionFromLiveEntity(activeCharacter, oldLevel, ent);

        const oldClientEntId = client.clientEntID;
        LevelHandler.clearTransferState(client, oldLevel, oldClientEntId);

        // 3. Calculate New Spawn / save logic like Python
        const spawn = LevelHandler.resolveDungeonExitSpawn(
            client,
            activeCharacter,
            oldLevel,
            targetLevel,
            syncState
        );
        const newX = spawn.x;
        const newY = spawn.y;
        const newHasCoord = spawn.hasCoord;
        syncPotionReservationForLevelTransition(activeCharacter, oldLevel, targetLevel);
        client.activePotionDrainAtMs = 0;
        LevelConfig.updateSavedLevelsOnTransfer(activeCharacter, oldLevel, targetLevel, newX, newY);
        if (!LevelConfig.isDungeonLevel(targetLevel)) {
            clearStoredDungeonSnapshot(activeCharacter);
        }

        if (client.userId) {
            await LevelHandler.saveCurrentCharacterSnapshot(client);
        }

        // 5. Generate New Token
        const newToken = LevelHandler.allocateTransferToken(targetLevel);
        
        // 6. Check House Visit Override
        const hostChar = LevelHandler.resolveVisitedCraftTownHostCharacter(
            client,
            transferToken,
            activeCharacter,
            targetLevel
        );

        // 7. Store Pending Transfer State
        const effectivePreviousLevel = targetLevel === 'CraftTown'
            ? LevelHandler.resolveCraftTownReturnLevel(client, activeCharacter, oldLevel, syncState)
            : LevelConfig.isDungeonLevel(targetLevel)
                ? LevelConfig.normalizeLevelName(syncState?.syncEntryLevel) || oldLevel
                : oldLevel;
        const sendExtendedOnTransfer = LevelHandler.shouldSendExtendedOnTransfer(targetLevel);
        LevelHandler.storePendingTransferToken(
            newToken,
            activeCharacter,
            client.userId,
            targetLevel,
            effectivePreviousLevel,
            newX,
            newY,
            newHasCoord,
            sendExtendedOnTransfer,
            syncState,
            doorContext,
            LevelHandler.isDifferentCharacter(activeCharacter, hostChar) ? hostChar : undefined,
            Number.isFinite(client.playSessionStartedAt) && client.playSessionStartedAt > 0
                ? Math.round(client.playSessionStartedAt)
                : Date.now()
        );
        LevelHandler.rememberTransferTokenAlias(packetToken, newToken);
        LevelHandler.rememberTransferTokenAlias(transferToken, newToken);
        
        // 8. Send Enter World (0x21)
        const levelSpec = LevelConfig.get(targetLevel);
        const isHard = targetLevel.endsWith("Hard");
        const oldLevelSpec = LevelConfig.get(oldLevel);
        const runtimeMapLevel = LevelHandler.resolveDungeonMapPacketLevel(targetLevel, levelSpec.mapId, activeCharacter, client);
        const runtimeBaseLevel = levelSpec.baseId;
        const isVisitedCraftTown = targetLevel === 'CraftTown' && LevelHandler.isDifferentCharacter(activeCharacter, hostChar);
        const craftTownOwnerToken = isVisitedCraftTown
            ? LevelHandler.resolveVisitedCraftTownOwnerToken(newToken, hostChar)
            : undefined;
        const momentParams = DungeonEntryDisplay.buildMomentParams(targetLevel, isHard ? "Hard" : "");
        
        const pkt = WorldEnter.buildEnterWorldPacket(
            newToken,
            0,
            oldLevelSpec.swf,
            hasOldCoord,
            Math.round(oldX),
            Math.round(oldY),
            Config.HOST,
            Config.PORTS[0],
            levelSpec.swf,
            runtimeMapLevel,
            runtimeBaseLevel,
            targetLevel,
            momentParams,
            isHard ? "Hard" : "",
            levelSpec.isDungeon,
            newHasCoord, newX, newY,
            hostChar,
            craftTownOwnerToken
        );

        DebugLogger.logProgress('EnterWorld:transferPacket', client, activeCharacter, {
            previousLevel: oldLevel,
            previousSwf: oldLevelSpec.swf,
            targetLevel,
            targetSwf: levelSpec.swf,
            transferToken: newToken,
            packetToken,
            effectivePreviousLevel,
            newHasCoord,
            newX,
            newY
        });

        client.sendBitBuffer(0x21, pkt);
    }

    private static markEnemyDefeatProcessed(client: Client, entityId: number, entity: any): void {
        if (entity && typeof entity === 'object') {
            entity.questDefeatProcessed = true;
        }

        const levelScope = getClientLevelScope(client);
        const scopedEntity = levelScope ? GlobalState.levelEntities.get(levelScope)?.get(entityId) : null;
        if (scopedEntity && typeof scopedEntity === 'object') {
            scopedEntity.questDefeatProcessed = true;
        }

        if (!levelScope) {
            return;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (getClientLevelScope(other) !== levelScope) {
                continue;
            }
            const localEntity = other.entities.get(entityId);
            if (localEntity && typeof localEntity === 'object') {
                localEntity.questDefeatProcessed = true;
            }
        }
    }

    private static isDefeatedEntityStateValue(entState: number): boolean {
        return entState === EntityState.DEAD || entState === 6;
    }

    // 0x07: Incremental Update (Movement)
    static handleEntityIncrementalUpdate(client: Client, data: Buffer): void {
        // data passed from Client is already the payload (header stripped)
        const br = new BitReader(data);
        const rawEntityId = br.readMethod4();
        const entityId = EntityHandler.resolveEntityAlias(client, rawEntityId);

        // If it's us and we haven't spawned, ignore
        // In TS we don't track 'player_spawned' explicitly like python yet, but usually we can ignore.
        
        const deltaX = br.readMethod45();
        const deltaY = br.readMethod45();
        const deltaVX = br.readMethod45();

        const STATE_BITS = 2; // Entity.const_316
        const entState = br.readMethod6(STATE_BITS);
        const isDefeatEntState = LevelHandler.isDefeatedEntityStateValue(entState);

        const flags = {
            bLeft: br.readMethod15(),
            bRunning: br.readMethod15(),
            bJumping: br.readMethod15(),
            bDropping: br.readMethod15(),
            bBackpedal: br.readMethod15()
        };

        const isAirborne = br.readMethod15();
        const velocityY = isAirborne ? br.readMethod24() : 0;

        // Update Entity
        if (!client.entities) return;
        const levelEntity = LevelHandler.getCurrentLevelMap(client)?.get(entityId);
        const ent = client.entities.get(rawEntityId) ?? client.entities.get(entityId) ?? levelEntity;
        if (!ent) return;
        const isSelf =
            EntityHandler.isClientOwnPlayerEntity(client, getClientLevelScope(client), entityId, ent) ||
            EntityHandler.isClientOwnPlayerEntity(client, getClientLevelScope(client), rawEntityId, ent);
        const currentLevel = client.currentLevel || "NewbieRoad";
        const isAliasedSharedClientSpawnUpdate =
            rawEntityId !== entityId &&
            EntityHandler.shouldMirrorClientSpawnEntityToParty(currentLevel, levelEntity ?? ent);
        if (isAliasedSharedClientSpawnUpdate) {
            EntityHandler.markSharedEntityRemoteUpdatesReady(client, entityId);
            const ownerToken = Math.round(Number((levelEntity ?? ent)?.ownerToken ?? 0));
            if (ownerToken > 0 && ownerToken !== client.token) {
                return;
            }
        } else {
            EntityHandler.markSharedEntityRemoteUpdatesReady(client, entityId);
        }

        const isEnemyEntity =
            !isSelf &&
            !ent.isPlayer &&
            Number(ent.team ?? 0) === EntityTeam.ENEMY;
        if (isEnemyEntity && isDefeatEntState && EntityHandler.isHomeDummyEntity(levelEntity ?? ent)) {
            ent.entState = EntityState.ACTIVE;
            ent.dead = false;
            ent.healthDelta = 0;
            ent.health_delta = 0;
            if (levelEntity && levelEntity !== ent) {
                levelEntity.entState = EntityState.ACTIVE;
                levelEntity.dead = false;
                levelEntity.healthDelta = 0;
                levelEntity.health_delta = 0;
            }
            EntityHandler.sendEntity(client, levelEntity ?? ent);
            return;
        }
        if (isEnemyEntity && isDefeatEntState) {
            const { CombatHandler } = require('./CombatHandler') as typeof import('./CombatHandler');
            const contributionSnapshot = CombatHandler.getContributionSnapshot(getClientLevelScope(client), entityId);
            if (contributionSnapshot.contributors.length) {
                ent.clientDefeatVerified = true;
                if (levelEntity && levelEntity !== ent) {
                    levelEntity.clientDefeatVerified = true;
                }
            }
        }
        const shouldIgnoreUnverifiedDungeonBossDeadState =
            isEnemyEntity &&
            isDefeatEntState &&
            MissionHandler.shouldIgnoreUnverifiedDungeonBossDefeat(currentLevel, levelEntity ?? ent);
        const canonicalEntState = shouldIgnoreUnverifiedDungeonBossDeadState
            ? EntityState.ACTIVE
            : entState;
        const canonicalIsDefeatState = LevelHandler.isDefeatedEntityStateValue(canonicalEntState);
        const isActiveSelfState = isSelf && !canonicalIsDefeatState;

        const previousX = Number(ent.x ?? 0);
        ent.x += deltaX;
        ent.y += deltaY;
        ent.v = Number(ent.v ?? 0) + deltaVX;
        ent.entState = canonicalEntState;
        ent.dead = canonicalIsDefeatState ? true : isActiveSelfState ? false : Boolean(ent.dead);
        ent.facingLeft = flags.bLeft;
        ent.bRunning = flags.bRunning;
        ent.bJumping = flags.bJumping;
        ent.bDropping = flags.bDropping;
        ent.bBackpedal = flags.bBackpedal;
        ent.velocityY = velocityY;
        ent.airborne = isAirborne;

        if (levelEntity && levelEntity !== ent) {
            levelEntity.x = ent.x;
            levelEntity.y = ent.y;
            levelEntity.v = ent.v;
            levelEntity.entState = canonicalEntState;
            levelEntity.dead = canonicalIsDefeatState ? true : isActiveSelfState ? false : Boolean(levelEntity.dead);
            levelEntity.facingLeft = flags.bLeft;
            levelEntity.bRunning = flags.bRunning;
            levelEntity.bJumping = flags.bJumping;
            levelEntity.bDropping = flags.bDropping;
            levelEntity.bBackpedal = flags.bBackpedal;
            levelEntity.velocityY = velocityY;
            levelEntity.airborne = isAirborne;
        }
        
        // Update Saved Coords if it's us and safe level
        if (isSelf && client.character) {
            const isDungeon = LevelConfig.get(currentLevel).isDungeon;
            
            if (currentLevel === "CraftTown" || !isDungeon) {
                if (!client.character.CurrentLevel) {
                    client.character.CurrentLevel = { name: currentLevel, x: ent.x, y: ent.y };
                } else {
                    client.character.CurrentLevel.name = currentLevel;
                    client.character.CurrentLevel.x = ent.x;
                    client.character.CurrentLevel.y = ent.y;
                }
            }

            if (currentLevel === 'CraftTownTutorial') {
                LevelHandler.maybeTriggerCraftTownTutorialParrot(client, Number(ent.x ?? 0));
            }

            if (currentLevel === 'TutorialDungeon') {
                LevelHandler.maybeTriggerTutorialDungeonDropTutorial(
                    client,
                    Number(ent.x ?? 0),
                    Number(ent.y ?? 0),
                    {
                        bJumping: flags.bJumping,
                        bDropping: flags.bDropping,
                    }
                );
            }

            LevelHandler.maybeTriggerDeepgardDragonMiniBossIntro(
                client,
                previousX,
                Number(ent.x ?? 0),
                Number(ent.y ?? 0)
            );

            LevelHandler.maybeTriggerBackAlleyDealsBossIntro(
                client,
                previousX,
                Number(ent.x ?? 0),
                Number(ent.y ?? 0)
            );

            LevelHandler.maybeTriggerProdigalSonDefectorMoment(
                client,
                previousX,
                Number(ent.x ?? 0),
                Number(ent.y ?? 0)
            );
        }

        if (
            isEnemyEntity &&
            canonicalIsDefeatState &&
            !Boolean(ent.questDefeatProcessed)
        ) {
            const shouldProcessMissionProgress = MissionHandler.shouldWaitForEnemyKillStateMissionProgress(client, ent);
            const shouldProcessDungeonCompletion = MissionHandler.shouldProcessEnemyKillStateDungeonCompletion(client, ent);
            if (shouldProcessMissionProgress || shouldProcessDungeonCompletion) {
                LevelHandler.markEnemyDefeatProcessed(client, entityId, ent);
                if (shouldProcessMissionProgress) {
                    LevelHandler.deferMissionWork(
                        client,
                        'enemy defeat mission progress',
                        () => MissionHandler.handleEnemyDefeatMissionProgress(client, ent)
                    );
                }

                const levelScope = getClientLevelScope(client);
                const ownerToken = Math.round(Number(ent.ownerToken ?? 0));
                const authorityToken = ownerToken > 0
                    ? ownerToken
                    : (levelScope ? resolveSharedDungeonProgressAuthorityToken(levelScope) : 0);
                const authorityClient = authorityToken > 0 ? GlobalState.sessionsByToken.get(authorityToken) : null;
                const completionClient = authorityClient && areClientsInSameLevelScope(client, authorityClient)
                    ? authorityClient
                    : client;

                if (shouldProcessDungeonCompletion) {
                    LevelHandler.deferMissionWork(
                        client,
                        'forced dungeon boss completion',
                        () => MissionHandler.handleForcedDungeonBossCompletion(completionClient, ent)
                    );
                }
            }
        }

        if (isSelf && isDefeatEntState) {
            const { CombatHandler } = require('./CombatHandler') as typeof import('./CombatHandler');
            CombatHandler.notePlayerDeathState(client);
        }

        if (!client.playerSpawned || !client.currentLevel) {
            return;
        }

        const relayEntity = levelEntity ?? ent;
        const relayData = rawEntityId === entityId
            ? data
            : LevelHandler.buildEntityIncrementalUpdatePayload(
                entityId,
                deltaX,
                deltaY,
                deltaVX,
                canonicalEntState,
                flags,
                isAirborne,
                velocityY
            );
        for (const other of LevelHandler.forLevelRecipients(client)) {
            if (!EntityHandler.canClientSeeEntity(other, relayEntity)) {
                continue;
            }
            const isSharedClientSpawnEntity = EntityHandler.shouldMirrorClientSpawnEntityToParty(client.currentLevel, relayEntity);
            if (isSharedClientSpawnEntity) {
                // These enemies are physically owned by each Flash client.
                // Relaying remote movement into a joiner's local enemy can make
                // LinkUpdater touch gfx before the client has built it.
                continue;
            } else if (!EntityHandler.ensureEntityKnown(other, client.currentLevel, entityId)) {
                continue;
            }

            const localEntityId = EntityHandler.resolveEntityLocalId(other, entityId);
            const outboundData = localEntityId === entityId
                ? relayData
                : LevelHandler.buildEntityIncrementalUpdatePayload(
                    localEntityId,
                    deltaX,
                    deltaY,
                    deltaVX,
                    canonicalEntState,
                    flags,
                    isAirborne,
                    velocityY
                );
            other.send(0x07, outboundData);
        }
    }

}
