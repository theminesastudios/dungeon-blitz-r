import { LevelHandler } from '../handlers/LevelHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { SocialHandler } from '../handlers/SocialHandler';
import { LevelConfig } from '../core/LevelConfig';
import { GlobalState } from '../core/GlobalState';
import { getClientLevelScope, getScopeLevelName } from '../core/LevelScope';
import { BitReader } from '../network/protocol/bitReader';

type NephitMissionHandler = typeof MissionHandler & {
    buildSyntheticLevelCompletePacket?: (completionPercent: number) => Buffer;
    hasFinalizedDungeonCompletion?: (client: any, levelScope: string) => boolean;
    hasMetRequiredDungeonCompletionObjectives?: (client: any, levelName: string, levelScope: string) => boolean;
    hasRemainingDungeonHostiles?: (levelScope: string) => boolean;
    getDungeonCompletionObjectiveProgress?: (levelScope: string) => {
        bossDefeated?: boolean;
        defeatedBossNames?: Set<string>;
        defeatedBossNameTimes?: Map<string, number>;
        bossRoomId?: number;
    };
    markRequiredDungeonBossDefeated?: (levelScope: string, levelName: string | null | undefined, entity: any) => void;
    __nephitBossDefeatCompletionPatchInstalled?: boolean;
};

type PatchedLevelHandler = typeof LevelHandler & {
    __nephitRoomCloseCompletionPatchInstalled?: boolean;
};

type PatchedSocialHandler = typeof SocialHandler & {
    __nephitFinalDialogueCompletionPatchInstalled?: boolean;
};

const NEPHIT_FINAL_DIALOGUE_TEXTS = new Set([
    'i wonder what the dream dragon he mentioned might be.',
    'i wonder what the dream dragon he mentioned might be'
]);

// Long enough for the authored post-boss cinematic/dialogue to finish, but only
// armed after the server has seen the Nephit boss defeat evidence.
const NEPHIT_STATS_AFTER_BOSS_DEFEAT_MS = 12500;
const NEPHIT_STATS_AFTER_FINAL_DIALOGUE_MS = 2500;

const pendingFinalDialogueTimers = new Map<string, NodeJS.Timeout>();
const pendingBossDefeatTimers = new Map<string, NodeJS.Timeout>();

function isNephitsQuestLevel(levelName: string | null | undefined): boolean {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
    return normalizedLevel === 'GhostBossDungeon' || normalizedLevel === 'GhostBossDungeonHard';
}

function getNephitRequiredBossName(levelName: string | null | undefined): string {
    return LevelConfig.normalizeLevelName(levelName) === 'GhostBossDungeonHard'
        ? 'NephitLargeEyeHard'
        : 'NephitLargeEye';
}

function normalizeRequiredName(value: string | null | undefined): string {
    return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getEntityName(entity: any): string {
    for (const raw of [entity?.name, entity?.EntName, entity?.entName, entity?.characterName, entity?.character_name]) {
        const value = String(raw ?? '').replace(/^,+/, '').trim();
        if (value) {
            return value;
        }
    }
    return '';
}

function isNephitBossName(name: string | null | undefined): boolean {
    const key = normalizeRequiredName(name);
    return key === 'nephit' || key === 'nephithard' || key === 'nephitlargeeye' || key === 'nephitlargeeyehard';
}

function normalizeDialogueText(text: string | null | undefined): string {
    return String(text ?? '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function isNephitFinalDialogue(text: string | null | undefined): boolean {
    return NEPHIT_FINAL_DIALOGUE_TEXTS.has(normalizeDialogueText(text));
}

function markNephitBossDefeated(levelScope: string, levelName: string, roomId: number): void {
    const missionHandler = MissionHandler as NephitMissionHandler;
    const progress = missionHandler.getDungeonCompletionObjectiveProgress?.(levelScope);
    if (!progress) {
        return;
    }

    const bossName = getNephitRequiredBossName(levelName);
    progress.bossDefeated = true;
    progress.defeatedBossNames?.add(bossName);
    progress.defeatedBossNameTimes?.set(bossName, Date.now());
    if (roomId > 0) {
        progress.bossRoomId = roomId;
    }

    // Ensure the normal MissionHandler objective gate no longer sees a live
    // Nephit copy/proxy in the completion room. The Flash client can leave a
    // scripted boss proxy around visually while the encounter is already over.
    const levelMap = GlobalState.levelEntities.get(levelScope);
    if (levelMap?.size) {
        for (const entity of levelMap.values()) {
            if (!entity || entity.isPlayer || !isNephitBossName(getEntityName(entity))) {
                continue;
            }
            entity.dead = true;
            entity.hp = 0;
            entity.untargetable = true;
            entity.entState = 6;
            if (roomId > 0 && !Number.isFinite(Number(entity.roomId))) {
                entity.roomId = roomId;
            }
        }
    }
}

function getNephitClientsInScope(levelScope: string, preferredClient?: any): any[] {
    const clients: any[] = [];
    const seen = new Set<any>();
    if (preferredClient && getClientLevelScope(preferredClient) === levelScope) {
        clients.push(preferredClient);
        seen.add(preferredClient);
    }

    for (const session of GlobalState.sessionsByToken.values()) {
        if (seen.has(session) || !session?.playerSpawned || getClientLevelScope(session) !== levelScope) {
            continue;
        }
        clients.push(session);
        seen.add(session);
    }

    return clients;
}

async function forceNephitCompletionForScope(
    levelScope: string,
    levelName: string,
    roomId: number,
    reason: 'roomClose' | 'finalDialogue' | 'bossDefeatTimer',
    preferredClient?: any
): Promise<void> {
    const clients = getNephitClientsInScope(levelScope, preferredClient);
    if (!clients.length) {
        console.log(`[NephitsQuest] ${reason} completion skipped: no clients in scope=${levelScope}`);
        return;
    }

    markNephitBossDefeated(levelScope, levelName, roomId);

    const missionHandler = MissionHandler as NephitMissionHandler;
    const payload = missionHandler.buildSyntheticLevelCompletePacket?.(100);
    if (!payload) {
        console.log(`[NephitsQuest] ${reason} completion failed: no synthetic completion packet builder`);
        return;
    }

    for (const client of clients) {
        if (!client?.character || missionHandler.hasFinalizedDungeonCompletion?.(client, levelScope)) {
            continue;
        }

        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character.CurrentLevel?.name ?? '')) ||
            levelName;
        if (!isNephitsQuestLevel(currentLevel)) {
            continue;
        }

        client.character.questTrackerState = 100;
        client.pendingDungeonCompletionWaitForCutsceneEnd = false;
        if (String(client.pendingDungeonCompletionScope ?? '').trim() === levelScope) {
            client.pendingDungeonCompletionScope = '';
            client.pendingDungeonCompletionPayload = null;
            if (client.pendingDungeonCompletionTimer) {
                clearTimeout(client.pendingDungeonCompletionTimer);
                client.pendingDungeonCompletionTimer = null;
            }
        }
        if (String(client.activeDungeonCutsceneScope ?? '').trim() === levelScope) {
            client.activeDungeonCutsceneScope = '';
            client.activeDungeonCutsceneRoomId = 0;
        }

        client.forcedDungeonCompletionScope = levelScope;
        const previousFlushActive = Boolean(client.pendingDungeonCompletionFlushActive);
        client.pendingDungeonCompletionFlushActive = true;
        try {
            console.log(`[NephitsQuest] forcing rank/statistics reason=${reason} roomId=${roomId}`);
            await MissionHandler.handleSetLevelComplete(client, Buffer.from(payload));
        } finally {
            client.pendingDungeonCompletionFlushActive = previousFlushActive;
        }
    }
}

async function finalizeNephitAfterBossScene(
    client: any,
    roomId: number,
    reason: 'roomClose' | 'finalDialogue'
): Promise<void> {
    const levelScope = getClientLevelScope(client);
    const currentLevel =
        LevelConfig.normalizeLevelName(client?.currentLevel || String(client?.character?.CurrentLevel?.name ?? '')) ||
        getScopeLevelName(levelScope);

    if (!client?.character || !levelScope || !isNephitsQuestLevel(currentLevel)) {
        return;
    }

    const missionHandler = MissionHandler as NephitMissionHandler;
    if (missionHandler.hasFinalizedDungeonCompletion?.(client, levelScope)) {
        return;
    }

    const questComplete = Math.max(0, Number(client.character.questTrackerState ?? 0)) >= 100;
    const pendingCompletion = String(client.pendingDungeonCompletionScope ?? '').trim() === levelScope;
    const noRemainingHostiles = missionHandler.hasRemainingDungeonHostiles
        ? !missionHandler.hasRemainingDungeonHostiles(levelScope)
        : false;

    // The final dialogue is only authored after the boss death cinematic. The
    // quest tracker may still be 26%, so the final dialogue itself is treated as
    // a valid post-boss completion signal.
    if (reason !== 'finalDialogue' && !questComplete && !pendingCompletion && !noRemainingHostiles) {
        console.log(
            `[NephitsQuest] room close observed but completion blocked: ` +
            `level=${currentLevel} roomId=${roomId} questComplete=${questComplete} ` +
            `pending=${pendingCompletion} noRemainingHostiles=${noRemainingHostiles}`
        );
        return;
    }

    await forceNephitCompletionForScope(levelScope, currentLevel, roomId, reason, client);
}

function scheduleNephitCompletionAfterBossDefeat(
    levelScope: string,
    levelName: string | null | undefined,
    entity: any
): void {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName) || getScopeLevelName(levelScope);
    if (!levelScope || !isNephitsQuestLevel(normalizedLevel)) {
        return;
    }

    const entityName = getEntityName(entity);
    if (entityName && !isNephitBossName(entityName)) {
        return;
    }

    const existingTimer = pendingBossDefeatTimers.get(levelScope);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    const roomId = Math.max(0, Math.round(Number(entity?.roomId ?? entity?.RoomID ?? 0)));
    markNephitBossDefeated(levelScope, normalizedLevel, roomId);
    console.log(`[NephitsQuest] boss defeat observed; scheduling rank/statistics roomId=${roomId}`);
    const timer = setTimeout(() => {
        pendingBossDefeatTimers.delete(levelScope);
        void forceNephitCompletionForScope(levelScope, normalizedLevel, roomId, 'bossDefeatTimer').catch((error) => {
            console.error('[NephitsQuest] failed to finalize after boss defeat timer:', error);
        });
    }, NEPHIT_STATS_AFTER_BOSS_DEFEAT_MS);
    timer.unref?.();
    pendingBossDefeatTimers.set(levelScope, timer);
}

function scheduleNephitFinalDialogueCompletion(client: any, text: string, source: 'roomThought' | 'startSkit'): void {
    if (!isNephitFinalDialogue(text)) {
        return;
    }

    const levelScope = getClientLevelScope(client);
    const currentLevel =
        LevelConfig.normalizeLevelName(client?.currentLevel || String(client?.character?.CurrentLevel?.name ?? '')) ||
        getScopeLevelName(levelScope);
    if (!client?.character || !levelScope || !isNephitsQuestLevel(currentLevel)) {
        return;
    }

    const existingTimer = pendingFinalDialogueTimers.get(levelScope);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    const roomId = Math.max(0, Math.round(Number(client.currentRoomId ?? 0)));
    console.log(`[NephitsQuest] final boss dialogue observed source=${source} roomId=${roomId}`);
    const timer = setTimeout(() => {
        pendingFinalDialogueTimers.delete(levelScope);
        void finalizeNephitAfterBossScene(client, roomId, 'finalDialogue').catch((error) => {
            console.error('[NephitsQuest] failed to finalize after final dialogue:', error);
        });
    }, NEPHIT_STATS_AFTER_FINAL_DIALOGUE_MS);
    timer.unref?.();
    pendingFinalDialogueTimers.set(levelScope, timer);
}

function readRoomId(data: Buffer): number {
    try {
        const br = new BitReader(data);
        const roomId = br.readMethod9();
        return Math.max(0, Math.round(Number(roomId ?? 0)));
    } catch {
        return 0;
    }
}

function readRoomThoughtText(data: Buffer): string {
    try {
        const br = new BitReader(data);
        br.readMethod4();
        return String(br.readMethod13() ?? '');
    } catch {
        return '';
    }
}

function readStartSkitText(data: Buffer): string {
    try {
        const br = new BitReader(data);
        br.readMethod9();
        br.readMethod15();
        return String(br.readMethod26() ?? '');
    } catch {
        return '';
    }
}

export function installNephitBossDefeatCompletionPatch(): void {
    const missionHandler = MissionHandler as NephitMissionHandler;
    if (missionHandler.__nephitBossDefeatCompletionPatchInstalled) {
        return;
    }

    const originalMarkRequiredDungeonBossDefeated = missionHandler.markRequiredDungeonBossDefeated?.bind(MissionHandler);
    if (typeof originalMarkRequiredDungeonBossDefeated !== 'function') {
        console.log('[NephitsQuest] boss defeat patch could not install: markRequiredDungeonBossDefeated missing');
        return;
    }

    missionHandler.__nephitBossDefeatCompletionPatchInstalled = true;
    missionHandler.markRequiredDungeonBossDefeated = (levelScope: string, levelName: string | null | undefined, entity: any): void => {
        originalMarkRequiredDungeonBossDefeated(levelScope, levelName, entity);
        scheduleNephitCompletionAfterBossDefeat(levelScope, levelName, entity);
    };
}

export function installNephitRoomCloseCompletionPatch(): void {
    const levelHandler = LevelHandler as PatchedLevelHandler;
    if (levelHandler.__nephitRoomCloseCompletionPatchInstalled) {
        return;
    }

    const originalHandleRoomClose = LevelHandler.handleRoomClose.bind(LevelHandler);
    levelHandler.__nephitRoomCloseCompletionPatchInstalled = true;

    LevelHandler.handleRoomClose = (client: any, data: Buffer): void => {
        const roomId = readRoomId(data);
        originalHandleRoomClose(client, data);
        void finalizeNephitAfterBossScene(client, roomId, 'roomClose').catch((error) => {
            console.error('[NephitsQuest] failed to finalize after room close:', error);
        });
    };
}

export function installNephitFinalDialogueCompletionPatch(): void {
    const socialHandler = SocialHandler as PatchedSocialHandler;
    if (socialHandler.__nephitFinalDialogueCompletionPatchInstalled) {
        return;
    }

    const originalHandleRoomThought = SocialHandler.handleRoomThought.bind(SocialHandler);
    const originalHandleStartSkit = SocialHandler.handleStartSkit.bind(SocialHandler);
    socialHandler.__nephitFinalDialogueCompletionPatchInstalled = true;

    SocialHandler.handleRoomThought = (client: any, data: Buffer): void => {
        const text = readRoomThoughtText(data);
        originalHandleRoomThought(client, data);
        scheduleNephitFinalDialogueCompletion(client, text, 'roomThought');
    };

    SocialHandler.handleStartSkit = (client: any, data: Buffer): void => {
        const text = readStartSkitText(data);
        originalHandleStartSkit(client, data);
        scheduleNephitFinalDialogueCompletion(client, text, 'startSkit');
    };
}

installNephitBossDefeatCompletionPatch();
installNephitRoomCloseCompletionPatch();
installNephitFinalDialogueCompletionPatch();
