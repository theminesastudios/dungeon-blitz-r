import rawConditions from '../data/dungeon_completion_conditions.json';
import { LevelConfig } from './LevelConfig';
import type {
    DungeonCompletionCondition,
    DungeonCompletionEntityObjective,
    DungeonCompletionMode
} from './DungeonCompletionTypes';
import { isRoomBossEntity } from './RoomBossState';

type RawCatalog = {
    schemaVersion?: unknown;
    levels?: Record<string, DungeonCompletionCondition>;
};

const catalog = rawConditions as RawCatalog;
const VALID_MODES = new Set<DungeonCompletionMode>(['bosses', 'objectives', 'full-clear', 'client-signal', 'disabled']);
const VALID_PARTY_HOSTILE_SYNC_POLICIES = new Set(['all', 'bosses-only', 'none']);

function normalizeIdentity(value: unknown): string {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function getEntityNames(entity: any): string[] {
    const names = new Set<string>();
    for (const value of [
        entity?.name,
        entity?.EntName,
        entity?.entName,
        entity?.characterName,
        entity?.character_name,
        entity?.roomBossName,
        entity?.displayName,
        entity?.DisplayName
    ]) {
        const name = String(value ?? '').replace(/^,+/, '').trim();
        if (name) {
            names.add(name);
        }
    }
    return [...names];
}

function hasExplicitRoomBossMarker(entity: any): boolean {
    const roomBossRoomId = Number(entity?.roomBossRoomId ?? NaN);
    return Boolean(entity?.isRoomBoss) ||
        Boolean(entity?.roomBoss) ||
        (Number.isFinite(roomBossRoomId) && roomBossRoomId >= 0) ||
        String(entity?.roomBossName ?? '').trim().length > 0;
}

function cloneObjective(objective: DungeonCompletionEntityObjective): DungeonCompletionEntityObjective {
    return {
        names: [...objective.names],
        aliases: objective.aliases ? [...objective.aliases] : undefined,
        role: objective.role,
        requiredCount: objective.requiredCount
    };
}

function cloneCondition(condition: DungeonCompletionCondition): DungeonCompletionCondition {
    return {
        ...condition,
        bossGroups: condition.bossGroups?.map((group) => [...group]),
        bossAliases: condition.bossAliases ? { ...condition.bossAliases } : undefined,
        entityObjectives: condition.entityObjectives?.map(cloneObjective),
        cutscene: condition.cutscene ? { ...condition.cutscene } : undefined,
        clientAuthorityBosses: condition.clientAuthorityBosses ? [...condition.clientAuthorityBosses] : undefined
    };
}

export class DungeonCompletionConditions {
    static readonly SCHEMA_VERSION = 2;

    static get(levelName: string | null | undefined): DungeonCompletionCondition | null {
        const normalized = LevelConfig.normalizeLevelName(levelName) || String(levelName ?? '').trim();
        const condition = normalized ? catalog.levels?.[normalized] : undefined;
        return condition ? cloneCondition(condition) : null;
    }

    static getConfiguredLevelNames(): string[] {
        return Object.keys(catalog.levels ?? {}).sort();
    }

    static isFullClear(levelName: string | null | undefined): boolean {
        return DungeonCompletionConditions.get(levelName)?.mode === 'full-clear';
    }

    static requiresBosses(levelName: string | null | undefined): boolean {
        return DungeonCompletionConditions.get(levelName)?.mode === 'bosses';
    }

    static sharesClientHostileWithParty(levelName: string | null | undefined, entity: any): boolean {
        const condition = DungeonCompletionConditions.get(levelName);
        if (condition?.partyHostileSync === 'none') {
            return false;
        }
        if (!condition || condition.partyHostileSync !== 'bosses-only') {
            return true;
        }
        return DungeonCompletionConditions.isRequiredBoss(levelName, entity);
    }

    static hasPostObjectiveCutscene(levelName: string | null | undefined): boolean {
        return Boolean(DungeonCompletionConditions.get(levelName)?.cutscene?.requiredAfterObjectives);
    }

    static allowsDefeatedBossProxyCopies(levelName: string | null | undefined): boolean {
        return Boolean(DungeonCompletionConditions.get(levelName)?.allowDefeatedBossProxyCopies);
    }

    static requiresPlayerDamageForClientBosses(levelName: string | null | undefined): boolean {
        return Boolean(DungeonCompletionConditions.get(levelName)?.requirePlayerDamageForClientBosses);
    }

    static requiresBossDefeatSignal(levelName: string | null | undefined): boolean {
        return Boolean(DungeonCompletionConditions.get(levelName)?.requireBossDefeatSignal);
    }

    static getSimultaneousBossWindowMs(levelName: string | null | undefined): number {
        return Math.max(0, Math.round(Number(DungeonCompletionConditions.get(levelName)?.simultaneousBossWindowMs ?? 0)));
    }

    static requiresBossesCurrentlyDefeated(levelName: string | null | undefined): boolean {
        return Boolean(DungeonCompletionConditions.get(levelName)?.requireBossesCurrentlyDefeated);
    }

    static acceptsRoomBossClearSignal(levelName: string | null | undefined): boolean {
        return Boolean(DungeonCompletionConditions.get(levelName)?.acceptRoomBossClearSignal);
    }

    static getRequiredBossNames(levelName: string | null | undefined): ReadonlySet<string> {
        const names = new Set<string>();
        for (const group of DungeonCompletionConditions.get(levelName)?.bossGroups ?? []) {
            for (const name of group) {
                names.add(name);
            }
        }
        return names;
    }

    static getCanonicalBossName(
        levelName: string | null | undefined,
        entity: any,
        levelScope: string = ''
    ): string {
        const condition = DungeonCompletionConditions.get(levelName);
        if (!condition || condition.mode !== 'bosses') {
            return '';
        }

        const requiredByKey = new Map<string, string>();
        for (const group of condition.bossGroups ?? []) {
            for (const name of group) {
                requiredByKey.set(normalizeIdentity(name), name);
            }
        }
        for (const [alias, canonical] of Object.entries(condition.bossAliases ?? {})) {
            requiredByKey.set(normalizeIdentity(alias), canonical);
        }

        for (const entityName of getEntityNames(entity)) {
            const normalizedEntityName = normalizeIdentity(entityName);
            const canonical = requiredByKey.get(normalizedEntityName);
            if (canonical) {
                if (
                    condition.requireRoomBossMarker &&
                    !hasExplicitRoomBossMarker(entity) &&
                    !(levelScope && isRoomBossEntity(levelScope, entity))
                ) {
                    const verifiedClientBossWithoutMarker = Boolean(
                        condition.allowVerifiedClientBossWithoutRoomBossMarker &&
                        entity?.clientSpawned &&
                        entity?.playerDamageContributed &&
                        normalizedEntityName === normalizeIdentity(canonical) &&
                        (condition.clientAuthorityBosses ?? [])
                            .map(normalizeIdentity)
                            .includes(normalizeIdentity(canonical))
                    );
                    const terminalCanonicalBossWithoutMarker = Boolean(
                        condition.allowTerminalCanonicalBossWithoutRoomBossMarker &&
                        !entity?.clientSpawned &&
                        (
                            normalizedEntityName === normalizeIdentity(canonical) ||
                            normalizedEntityName === normalizeIdentity(canonical).replace(/hard$/, '')
                        ) &&
                        (
                            entity?.dead ||
                            entity?.destroyed ||
                            Number(entity?.hp ?? 1) <= 0
                        )
                    );
                    if (!verifiedClientBossWithoutMarker && !terminalCanonicalBossWithoutMarker) {
                        return '';
                    }
                }
                return canonical;
            }
        }
        return '';
    }

    static isRequiredBoss(levelName: string | null | undefined, entity: any, levelScope: string = ''): boolean {
        return Boolean(DungeonCompletionConditions.getCanonicalBossName(levelName, entity, levelScope));
    }

    static isClientAuthorityBoss(
        levelName: string | null | undefined,
        entity: any,
        levelScope: string = ''
    ): boolean {
        if (!Boolean(entity?.clientSpawned)) {
            return false;
        }
        const condition = DungeonCompletionConditions.get(levelName);
        const allowed = new Set((condition?.clientAuthorityBosses ?? []).map(normalizeIdentity));
        const canonical = DungeonCompletionConditions.getCanonicalBossName(levelName, entity, levelScope);
        return Boolean(canonical && allowed.has(normalizeIdentity(canonical)));
    }

    static getObjectiveRole(levelName: string | null | undefined, entity: any): string {
        const condition = DungeonCompletionConditions.get(levelName);
        const entityKeys = new Set(getEntityNames(entity).map(normalizeIdentity));
        for (const objective of condition?.entityObjectives ?? []) {
            const keys = [...objective.names, ...(objective.aliases ?? [])].map(normalizeIdentity);
            if (keys.some((key) => entityKeys.has(key))) {
                return objective.role;
            }
        }
        return '';
    }

    static validate(configuredDungeonLevelNames: Iterable<string>): string[] {
        const errors: string[] = [];
        if (Number(catalog.schemaVersion) !== DungeonCompletionConditions.SCHEMA_VERSION) {
            errors.push(`schemaVersion must be ${DungeonCompletionConditions.SCHEMA_VERSION}`);
        }

        const levels = catalog.levels ?? {};
        for (const levelName of configuredDungeonLevelNames) {
            const normalized = LevelConfig.normalizeLevelName(levelName) || String(levelName ?? '').trim();
            if (normalized && !levels[normalized]) {
                errors.push(`missing condition for dungeon ${normalized}`);
            }
        }

        for (const [levelName, condition] of Object.entries(levels)) {
            if (!condition || !VALID_MODES.has(condition.mode)) {
                errors.push(`${levelName}: invalid mode`);
                continue;
            }
            if (
                condition.partyHostileSync &&
                !VALID_PARTY_HOSTILE_SYNC_POLICIES.has(condition.partyHostileSync)
            ) {
                errors.push(`${levelName}: invalid party hostile sync policy`);
            }
            if (condition.partyHostileSync === 'bosses-only' && condition.mode !== 'bosses') {
                errors.push(`${levelName}: bosses-only party hostile sync requires boss mode`);
            }
            if (condition.mode === 'bosses') {
                if (!condition.bossGroups?.length || condition.bossGroups.some((group) => !group.length)) {
                    errors.push(`${levelName}: boss mode requires non-empty bossGroups`);
                }
                const canonicalBosses = new Set((condition.bossGroups ?? []).flat());
                for (const [alias, canonical] of Object.entries(condition.bossAliases ?? {})) {
                    if (!alias.trim() || !canonicalBosses.has(canonical)) {
                        errors.push(`${levelName}: boss alias ${alias} targets unknown boss ${canonical}`);
                    }
                }
                for (const clientBoss of condition.clientAuthorityBosses ?? []) {
                    if (!canonicalBosses.has(clientBoss)) {
                        errors.push(`${levelName}: client-authority boss ${clientBoss} is not required`);
                    }
                }
                if (condition.requireRoomBossMarker !== undefined && typeof condition.requireRoomBossMarker !== 'boolean') {
                    errors.push(`${levelName}: requireRoomBossMarker must be boolean`);
                }
                if (condition.requireBossDefeatSignal !== undefined && typeof condition.requireBossDefeatSignal !== 'boolean') {
                    errors.push(`${levelName}: requireBossDefeatSignal must be boolean`);
                }
                if (
                    condition.allowTerminalCanonicalBossWithoutRoomBossMarker !== undefined &&
                    typeof condition.allowTerminalCanonicalBossWithoutRoomBossMarker !== 'boolean'
                ) {
                    errors.push(`${levelName}: allowTerminalCanonicalBossWithoutRoomBossMarker must be boolean`);
                }
                if (
                    condition.requireBossesCurrentlyDefeated !== undefined &&
                    typeof condition.requireBossesCurrentlyDefeated !== 'boolean'
                ) {
                    errors.push(`${levelName}: requireBossesCurrentlyDefeated must be boolean`);
                }
                if (
                    condition.acceptRoomBossClearSignal !== undefined &&
                    typeof condition.acceptRoomBossClearSignal !== 'boolean'
                ) {
                    errors.push(`${levelName}: acceptRoomBossClearSignal must be boolean`);
                }
            }
            if (condition.mode === 'objectives' && !condition.entityObjectives?.length) {
                errors.push(`${levelName}: objectives mode requires non-empty entityObjectives`);
            }
            if (condition.mode !== 'bosses' && (condition.bossGroups?.length || condition.bossAliases)) {
                errors.push(`${levelName}: non-boss mode must not define bosses`);
            }
            if (
                condition.cutscene &&
                !condition.cutscene.requiredAfterObjectives
            ) {
                errors.push(`${levelName}: invalid cutscene completion gate`);
            }
            for (const objective of condition.entityObjectives ?? []) {
                if (!objective.role.trim() || !objective.names.length) {
                    errors.push(`${levelName}: entity objective requires role and names`);
                }
                if (
                    objective.requiredCount !== undefined &&
                    (!Number.isInteger(objective.requiredCount) || objective.requiredCount <= 0)
                ) {
                    errors.push(`${levelName}: entity objective requiredCount must be a positive integer`);
                }
            }
        }
        return errors;
    }
}
