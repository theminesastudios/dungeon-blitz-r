import { LevelHandler } from '../handlers/LevelHandler';
import { MissionHandler } from '../handlers/MissionHandler';
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

function isNephitsQuestLevel(levelName: string | null | undefined): boolean {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
    return normalizedLevel === 'GhostBossDungeon' || normalizedLevel === 'GhostBossDungeonHard';
}

function getNephitRequiredBossName(levelName: string | null | undefined): string {
    return LevelConfig.normalizeLevelName(levelName) === 'GhostBossDungeonHard'
        ? 'NephitLargeEyeHard'
        : 'NephitLargeEye';
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

async function finalizeNephitAfterRoomClose(client: any, roomId: number): Promise<void> {
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

    if (!questComplete && !pendingCompletion && !noRemainingHostiles) {
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
            `[NephitsQuest] room close completion blocked after boss mark: ` +
            `level=${currentLevel} roomId=${roomId} questComplete=${questComplete} ` +
            `pending=${pendingCompletion} noRemainingHostiles=${noRemainingHostiles}`
        );
        return;
    }

    const payload = missionHandler.buildSyntheticLevelCompletePacket?.(100);
    if (!payload) {
        console.log('[NephitsQuest] room close completion failed: no synthetic completion packet builder');
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
    console.log(`[NephitsQuest] forcing rank/statistics after boss room cutscene end roomId=${roomId}`);
    await MissionHandler.handleSetLevelComplete(client, payload);
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
        void finalizeNephitAfterRoomClose(client, roomId).catch((error) => {
            console.error('[NephitsQuest] failed to finalize after room close:', error);
        });
    };
}

installNephitRoomCloseCompletionPatch();
