import { GlobalState } from './GlobalState';
import { LevelConfig } from './LevelConfig';

export class TransferTokenAllocator {
    private static readonly TOKEN_SPACE_SIZE = 0x10000;
    private static readonly RANDOM_ATTEMPTS = 128;

    private static normalizeTargetLevel(targetLevel: string | null | undefined): string {
        return LevelConfig.normalizeLevelName(String(targetLevel ?? '')) || String(targetLevel ?? '');
    }

    private static collectBlockedIds(targetLevel: string | null | undefined): Set<number> {
        const blockedIds = new Set<number>([0]);
        const normalizedTargetLevel = TransferTokenAllocator.normalizeTargetLevel(targetLevel);

        for (const token of GlobalState.pendingWorld.keys()) {
            blockedIds.add(token);
        }
        for (const token of GlobalState.pendingExtended.keys()) {
            blockedIds.add(token);
        }
        for (const token of GlobalState.usedTransferTokens.keys()) {
            blockedIds.add(token);
        }
        for (const token of GlobalState.sessionsByToken.keys()) {
            blockedIds.add(token);
        }
        for (const token of GlobalState.tokenChar.keys()) {
            blockedIds.add(token);
        }
        for (const token of GlobalState.pendingTeleports.keys()) {
            blockedIds.add(token);
        }
        for (const [aliasToken, targetToken] of GlobalState.transferTokenAliases.entries()) {
            blockedIds.add(aliasToken);
            blockedIds.add(targetToken);
        }

        if (!normalizedTargetLevel) {
            return blockedIds;
        }

        const levelMap = GlobalState.levelEntities.get(normalizedTargetLevel);
        if (levelMap) {
            for (const entityId of levelMap.keys()) {
                if (entityId > 0) {
                    blockedIds.add(entityId);
                }
            }
        }

        for (const session of GlobalState.sessionsByToken.values()) {
            const sessionLevel = TransferTokenAllocator.normalizeTargetLevel(session.currentLevel);
            if (sessionLevel !== normalizedTargetLevel) {
                continue;
            }
            if (session.clientEntID > 0) {
                blockedIds.add(session.clientEntID);
            }
        }

        return blockedIds;
    }

    static allocate(targetLevel: string | null | undefined): number {
        const blockedIds = TransferTokenAllocator.collectBlockedIds(targetLevel);
        for (let attempt = 0; attempt < TransferTokenAllocator.RANDOM_ATTEMPTS; attempt++) {
            const candidate = Math.floor(Math.random() * TransferTokenAllocator.TOKEN_SPACE_SIZE);
            if (candidate > 0 && !blockedIds.has(candidate)) {
                return candidate;
            }
        }

        for (let candidate = 1; candidate < TransferTokenAllocator.TOKEN_SPACE_SIZE; candidate++) {
            if (!blockedIds.has(candidate)) {
                return candidate;
            }
        }

        const normalizedTargetLevel = TransferTokenAllocator.normalizeTargetLevel(targetLevel) || '(unknown level)';
        throw new Error(`[TransferTokenAllocator] No free transfer token available for ${normalizedTargetLevel}`);
    }
}
