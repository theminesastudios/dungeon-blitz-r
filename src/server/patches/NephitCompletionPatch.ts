import { LevelHandler } from '../handlers/LevelHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { SocialHandler } from '../handlers/SocialHandler';
import { LevelConfig } from '../core/LevelConfig';
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

const pendingFinalDialogueTimers = new Map<string, NodeJS.Timeout>();

function isNephitsQuestLevel(levelName: string | null | undefined): boolean {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
    return normalizedLevel === 'GhostBossDungeon' || normalizedLevel === 'GhostBossDungeonHard';
}

function getNephitRequiredBossName(levelName: string | null | undefined): string {
    return LevelConfig.normalizeLevelName(levelName) === 'GhostBossDungeonHard'
        ? 'NephitLargeEyeHard'
        : 'NephitLargeEye';
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
}

async function finalizeNephitAfterBossScene(
    client: any,
    roomId: number,
    reason: 'roomClose' | 'finalDialogue'
): Promise<void> {
    const missionHandler = MissionHandler as NephitMissionHandler;
    const levelScope = getClientLevelScope(client);
    const currentLevel =
        LevelConfig.normalizeLevelName(client?.currentLevel || String(client?.character?.CurrentLevel?.name ?? '')) ||
        getScopeLevelName(levelScope);

    if (!client?.character || !levelScope || !isNephitsQuestLevel(currentLevel)) {
        return;
    }

    if (missionHandler.hasFinalizedDungeonCompletion?.(client, levelScope)) {
        return;
    }

    const questComplete = Math.max(0, Number(client.character.questTrackerState ?? 0)) >= 100;
    const pendingCompletion = String(client.pendingDungeonCompletionScope ?? '').trim() === levelScope;
    const noRemainingHostiles = missionHandler.hasRemainingDungeonHostiles
        ? !missionHandler.hasRemainingDungeonHostiles(levelScope)
        : false;

    // The Nephit final dialogue is only authored after the boss death cinematic.
    // In this dungeon the normal quest tracker may still be 26%, so the final
    // dialogue itself is treated as the post-boss completion signal.
    if (reason !== 'finalDialogue' && !questComplete && !pendingCompletion && !noRemainingHostiles) {
        console.log(
            `[NephitsQuest] room close observed but completion blocked: ` +
            `level=${currentLevel} roomId=${roomId} questComplete=${questComplete} ` +
            `pending=${pendingCompletion} noRemainingHostiles=${noRemainingHostiles}`
        );
        return;
    }

    markNephitBossDefeated(levelScope, currentLevel, roomId);

    const objectivesMet = Boolean(
        missionHandler.hasMetRequiredDungeonCompletionObjectives?.(client, currentLevel, levelScope)
    );
    if (!objectivesMet) {
        console.log(
            `[NephitsQuest] ${reason} completion blocked after boss mark: ` +
            `level=${currentLevel} roomId=${roomId} questComplete=${questComplete} ` +
            `pending=${pendingCompletion} noRemainingHostiles=${noRemainingHostiles}`
        );
        return;
    }

    const payload = missionHandler.buildSyntheticLevelCompletePacket?.(100);
    if (!payload) {
        console.log(`[NephitsQuest] ${reason} completion failed: no synthetic completion packet builder`);
        return;
    }

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
    console.log(`[NephitsQuest] forcing rank/statistics after boss scene reason=${reason} roomId=${roomId}`);
    await MissionHandler.handleSetLevelComplete(client, payload);
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
    }, 2500);
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

installNephitRoomCloseCompletionPatch();
installNephitFinalDialogueCompletionPatch();
