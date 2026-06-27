import { CombatHandler } from '../handlers/CombatHandler';
import { MissionHandler } from '../handlers/MissionHandler';

type DungeonCompletionPatchTarget = {
    DUNGEONS_REQUIRING_BOSS_DEFEAT?: Set<string>;
    REQUIRED_DUNGEON_BOSS_NAMES_BY_LEVEL?: Record<string, ReadonlySet<string>>;
    CLIENT_AUTHORITY_REQUIRED_BOSS_LEVELS?: Set<string>;
    CLIENT_AUTHORITY_REQUIRED_BOSS_NAMES?: Set<string>;
};

type CombatAuthorityPatchTarget = {
    POWER_HIT_CLIENT_AUTHORITY_BOSS_LEVELS?: Set<string>;
    POWER_HIT_CLIENT_AUTHORITY_BOSS_NAMES?: Set<string>;
};

const SvarSpiteLevels = ['SRN_Mission3', 'SRN_Mission3Hard'] as const;
const SvarSpiteBosses = ['YoungDragonGreen', 'YoungDragonGreenHard'] as const;

function addAll(target: Set<string> | undefined, values: readonly string[]): void {
    for (const value of values) {
        target?.add(value);
    }
}

function applySvarSpiteDungeonCompletionPatch(): void {
    const missionHandler = MissionHandler as unknown as DungeonCompletionPatchTarget;
    const combatHandler = CombatHandler as unknown as CombatAuthorityPatchTarget;

    addAll(missionHandler.DUNGEONS_REQUIRING_BOSS_DEFEAT, SvarSpiteLevels);
    addAll(missionHandler.CLIENT_AUTHORITY_REQUIRED_BOSS_LEVELS, SvarSpiteLevels);
    addAll(missionHandler.CLIENT_AUTHORITY_REQUIRED_BOSS_NAMES, SvarSpiteBosses);

    addAll(combatHandler.POWER_HIT_CLIENT_AUTHORITY_BOSS_LEVELS, SvarSpiteLevels);
    addAll(combatHandler.POWER_HIT_CLIENT_AUTHORITY_BOSS_NAMES, SvarSpiteBosses);

    const requiredBossNames = missionHandler.REQUIRED_DUNGEON_BOSS_NAMES_BY_LEVEL;
    if (!requiredBossNames) {
        return;
    }

    requiredBossNames.SRN_Mission3 = new Set(['YoungDragonGreen']);
    requiredBossNames.SRN_Mission3Hard = new Set(['YoungDragonGreenHard']);
}

applySvarSpiteDungeonCompletionPatch();
