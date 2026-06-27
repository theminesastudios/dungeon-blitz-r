import { EntityState, EntityTeam } from './Entity';
import { GlobalState } from './GlobalState';
import { getClientLevelScope } from './LevelScope';
import { BitReader } from '../network/protocol/bitReader';
import { Client } from './Client';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
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

type SvarEntityDefeatPacket = {
    rawEntityId: number;
    entityId: number;
    defeated: boolean;
    entity: any;
};

const SvarSpiteLevels = ['SRN_Mission3', 'SRN_Mission3Hard'] as const;
const SvarSpiteBosses = ['YoungDragonGreen', 'YoungDragonGreenHard'] as const;
const SvarSpiteBossKeys = new Set(['youngdragongreen', 'youngdragongreenhard']);

let patchedIncrementalUpdate = false;

function addAll(target: Set<string> | undefined, values: readonly string[]): void {
    for (const value of values) {
        target?.add(value);
    }
}

function normalizeKey(value: unknown): string {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function getEntityKeys(entity: any): string[] {
    return [
        entity?.name,
        entity?.EntName,
        entity?.entName,
        entity?.characterName,
        entity?.character_name,
        entity?.roomBossName,
        entity?.displayName,
        entity?.DisplayName
    ]
        .map(normalizeKey)
        .filter((value) => value.length > 0);
}

function isSvarSpiteLevel(levelName: string | null | undefined): boolean {
    return SvarSpiteLevels.includes(String(levelName ?? '') as typeof SvarSpiteLevels[number]);
}

function isSvarSpiteBoss(levelName: string, entity: any): boolean {
    if (!isSvarSpiteLevel(levelName) || !entity || Boolean(entity.isPlayer) || Number(entity.team ?? 0) !== EntityTeam.ENEMY) {
        return false;
    }

    if (MissionHandler.isRequiredDungeonCompletionBossForLevel(levelName, entity)) {
        return true;
    }

    const keys = getEntityKeys(entity);
    return keys.some((key) => SvarSpiteBossKeys.has(key) || key.includes('svar') || key.includes('youngdragongreen'));
}

function parseSvarDefeatPacket(client: Client, data: Buffer): SvarEntityDefeatPacket | null {
    const levelName = String(client.currentLevel ?? '').trim();
    if (!isSvarSpiteLevel(levelName)) {
        return null;
    }

    try {
        const br = new BitReader(data);
        const rawEntityId = br.readMethod4();
        let entityId = EntityHandler.resolveEntityAlias(client, rawEntityId);
        const levelScope = getClientLevelScope(client);
        if (levelScope) {
            entityId = CombatHandler.resolveClientHostileAliasForSharedState(client, levelScope, entityId);
        }

        br.readMethod45();
        br.readMethod45();
        br.readMethod45();
        const entState = br.readMethod6(2);
        const defeated = entState === EntityState.DEAD || entState === 6;
        if (!defeated) {
            return null;
        }

        const entity = client.entities.get(rawEntityId) ??
            client.entities.get(entityId) ??
            GlobalState.levelEntities.get(levelScope)?.get(entityId);
        if (!isSvarSpiteBoss(levelName, entity)) {
            return null;
        }

        return { rawEntityId, entityId, defeated, entity };
    } catch {
        return null;
    }
}

function markSvarBossDefeated(levelScope: string, entityId: number, entity: any): void {
    const candidates = [
        entity,
        GlobalState.levelEntities.get(levelScope)?.get(entityId)
    ];

    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') {
            continue;
        }

        candidate.hp = 0;
        candidate.dead = true;
        candidate.entState = EntityState.DEAD;
        candidate.clientDefeatVerified = true;
        candidate.playerDamageContributed = true;
    }
}

function patchSvarSpiteIncrementalDefeat(): void {
    if (patchedIncrementalUpdate) {
        return;
    }
    patchedIncrementalUpdate = true;

    const original = LevelHandler.handleEntityIncrementalUpdate.bind(LevelHandler);
    LevelHandler.handleEntityIncrementalUpdate = (client: Client, data: Buffer): void => {
        const parsed = parseSvarDefeatPacket(client, data);
        if (parsed) {
            const levelScope = getClientLevelScope(client);
            if (levelScope) {
                markSvarBossDefeated(levelScope, parsed.entityId, parsed.entity);
                void MissionHandler.handleForcedDungeonBossCompletion(client, parsed.entity);
            }
        }

        original(client, data);
    };
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
    if (requiredBossNames) {
        requiredBossNames.SRN_Mission3 = new Set(['YoungDragonGreen']);
        requiredBossNames.SRN_Mission3Hard = new Set(['YoungDragonGreenHard']);
    }

    patchSvarSpiteIncrementalDefeat();
}

applySvarSpiteDungeonCompletionPatch();
