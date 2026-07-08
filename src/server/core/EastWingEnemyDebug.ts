import { EntityTeam } from './Entity';
import { LevelConfig } from './LevelConfig';
import { getScopeLevelName } from './LevelScope';

export type EnemyDeathCause =
    | 'combat_damage'
    | 'scripted_kill'
    | 'despawn'
    | 'cleanup'
    | 'destroy_only'
    | 'health_reconcile'
    | 'client_copy'
    | 'duplicate_cleanup'
    | 'room_sync'
    | 'visibility_sync'
    | 'spawn_replace'
    | 'aggro'
    | 'proximity'
    | 'unknown';

export type EastWingMutationDetails = {
    action: string;
    sourcePath: string;
    reason: string;
    level?: string;
    levelName?: string;
    dungeon?: string;
    scope?: string;
    roomId?: number;
    enemyId?: number;
    instanceId?: number;
    hpBefore?: number;
    hpAfter?: number;
    attackerId?: number;
    damageSource?: string;
    isCombatDamage?: boolean;
    deathCause?: EnemyDeathCause | string;
    [key: string]: unknown;
};

export type EnemyDeathContext = {
    cause: EnemyDeathCause;
    attackerId?: string | number;
    playerId?: string | number;
    skillId?: string | number;
    damageEventId?: string;
    damageAmount?: number;
    hpBefore?: number;
    hpAfter?: number;
    aliveBefore?: boolean;
    sourcePath?: string;
    levelScope?: string;
};

function normalizeLevelName(levelNameOrScope: string | null | undefined): string {
    return LevelConfig.normalizeLevelName(getScopeLevelName(String(levelNameOrScope ?? ''))) || '';
}

export function isEastWingLevel(levelNameOrScope: string | null | undefined): boolean {
    const normalizedLevel = normalizeLevelName(levelNameOrScope);
    return normalizedLevel === 'JC_Mini2' || normalizedLevel === 'JC_Mini2Hard';
}

export function isEastWingRequiredEnemy(levelNameOrScope: string | null | undefined, entity: any): boolean {
    return isEastWingLevel(levelNameOrScope) &&
        Boolean(entity) &&
        !Boolean(entity?.isPlayer) &&
        Number(entity?.team ?? EntityTeam.UNKNOWN) === EntityTeam.ENEMY &&
        (
            Boolean(entity?.requiredForClear) ||
            Boolean(entity?.serverAuthorityHostile) ||
            !Boolean(entity?.clientSpawned)
        );
}

export function getEastWingCombatDeathCause(entity: any): EnemyDeathCause {
    const raw = String(entity?.deathCause ?? entity?.combatDeathCause ?? '').trim();
    return raw === 'combat_damage' ? 'combat_damage' : 'unknown';
}

export function hasEastWingCombatDeathEvidence(entity: any): boolean {
    return getEastWingCombatDeathCause(entity) === 'combat_damage' &&
        Boolean(entity?.combatDeathValidated) &&
        Math.max(0, Math.round(Number(entity?.combatDeathAppliedDamage ?? 0))) > 0 &&
        Math.round(Number(entity?.combatDeathHpBefore ?? 0)) > 0 &&
        Math.round(Number(entity?.combatDeathHpAfter ?? entity?.hp ?? 0)) <= 0 &&
        Math.max(0, Math.round(Number(entity?.combatDeathAttackerId ?? 0))) > 0 &&
        String(entity?.combatDeathEventId ?? '').trim().length > 0;
}

export function isValidEastWingCombatDeathContext(context: EnemyDeathContext | null | undefined): boolean {
    if (!context || context.cause !== 'combat_damage') {
        return false;
    }

    return String(context.damageEventId ?? '').trim().length > 0 &&
        String(context.attackerId ?? context.playerId ?? '').trim().length > 0 &&
        Math.max(0, Math.round(Number(context.damageAmount ?? 0))) > 0 &&
        Math.round(Number(context.hpBefore ?? 0)) > 0 &&
        Math.round(Number(context.hpAfter ?? 1)) <= 0 &&
        context.aliveBefore === true;
}

export function buildEastWingDeathEventId(levelScope: string, entityId: number, attackerId: number, hpBefore: number, hpAfter: number): string {
    return [
        String(levelScope ?? '').trim(),
        Math.max(0, Math.round(Number(entityId) || 0)),
        Math.max(0, Math.round(Number(attackerId) || 0)),
        Math.max(0, Math.round(Number(hpBefore) || 0)),
        Math.max(0, Math.round(Number(hpAfter) || 0))
    ].join(':');
}

function stackPreview(): string {
    return String(new Error().stack ?? '')
        .split(/\r?\n/)
        .slice(2, 10)
        .map((line) => line.trim())
        .join(' <- ');
}

export function logEastWingEnemyMutation(details: EastWingMutationDetails, entity: any = null): void {
    const scope = String(details.scope ?? '').trim();
    const levelName = details.levelName ?? normalizeLevelName(scope || String(details.level ?? ''));
    if (!isEastWingLevel(levelName || scope)) {
        return;
    }

    const payload = {
        level: details.level ?? 'levelsJC',
        levelName,
        dungeon: details.dungeon ?? 'The East Wing',
        scope,
        roomId: details.roomId ?? Math.round(Number(entity?.roomId ?? entity?.RoomID ?? entity?.room_id ?? -1)),
        enemyId: details.enemyId ?? Math.max(0, Math.round(Number(entity?.canonicalId ?? entity?.id ?? 0))),
        instanceId: details.instanceId ?? Math.max(0, Math.round(Number(entity?.id ?? 0))),
        hpBefore: details.hpBefore ?? Math.round(Number(entity?.hp ?? 0)),
        hpAfter: details.hpAfter ?? Math.round(Number(entity?.hp ?? 0)),
        attackerId: details.attackerId ?? 0,
        damageSource: details.damageSource ?? '',
        isCombatDamage: Boolean(details.isCombatDamage),
        deathCause: details.deathCause ?? getEastWingCombatDeathCause(entity),
        stack: stackPreview(),
        ...details
    };
    const formatted = Object.entries(payload)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ');
    console.warn(`[EastWingEnemyMutation] ${formatted}`);
}

export function logEastWingProgressBlocked(reason: string, sourcePath: string, levelScope: string, entity: any, extra: Record<string, unknown> = {}): void {
    logEastWingEnemyMutation({
        action: 'progress_blocked',
        sourcePath,
        reason,
        scope: levelScope,
        isCombatDamage: false,
        ...extra
    }, entity);
    console.warn(`[EastWingProgressBlocked] reason=${reason} sourcePath=${sourcePath} stack=${stackPreview()}`);
}
