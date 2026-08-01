import { GlobalState } from './GlobalState';
import { DungeonCompletionConditions } from './DungeonCompletionConditions';
import { getScopeLevelName } from './LevelScope';
import { getScopeRuntimeLevel, clearScopeRuntimeLevel } from './RuntimeLevel';
import { isRoomBossEntity } from './RoomBossState';

// One dungeon boss, one record, for the whole level scope.
//
// Every client spawns its own copy of a boss and reports damage against that
// copy, so before this the "boss" was really N independent bosses that happened
// to share a name: N health pools, N deaths, N cutscenes. Whoever killed their
// copy first ended the room, and everyone else was left swinging at a corpse
// the server had already written off — or at a boss that was still at full
// health on their screen.
//
// The record below is the single place a boss's level, health pool and death
// live. Client copies are projections of it, never the source.
export type BossAuthorityRecord = {
    levelScope: string;
    canonicalName: string;
    level: number;
    maxHp: number;
    hp: number;
    dead: boolean;
    deadAt: number;
    // Damage reported per session token. Each client reports only what it dealt,
    // so these sum; keyed by token so a reconnecting player cannot double-count.
    reportedDamageByToken: Map<number, number>;
};

const bossRecordsByScope = new Map<string, Map<string, BossAuthorityRecord>>();
const ENEMY_TEAM = 2;

function normalizeScope(levelScope: string | null | undefined): string {
    return String(levelScope ?? '').trim();
}

function roundPositive(value: unknown, fallback: number = 0): number {
    const numeric = Math.round(Number(value ?? fallback));
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

// The name the record is keyed by. Falls back to the room-boss marker so a boss
// the completion catalog does not name still gets one shared pool rather than
// one per viewer.
export function getBossAuthorityKey(levelScope: string | null | undefined, entity: any): string {
    const scopeKey = normalizeScope(levelScope);
    if (!scopeKey || !entity || entity.isPlayer) {
        return '';
    }

    const canonical = DungeonCompletionConditions.getCanonicalBossName(
        getScopeLevelName(scopeKey),
        entity,
        scopeKey
    );
    if (canonical) {
        return canonical;
    }

    if (!isRoomBossEntity(scopeKey, entity)) {
        return '';
    }

    const markerName = String(entity.roomBossName ?? entity.name ?? entity.EntName ?? '').trim();
    return markerName ? `roomboss:${markerName.toLowerCase()}` : '';
}

export function getBossAuthorityRecord(
    levelScope: string | null | undefined,
    entity: any
): BossAuthorityRecord | null {
    const scopeKey = normalizeScope(levelScope);
    const key = getBossAuthorityKey(scopeKey, entity);
    return key ? bossRecordsByScope.get(scopeKey)?.get(key) ?? null : null;
}

// Creates the record on first sight of a boss and stamps the scope's numbers
// onto this copy. Idempotent — called from every path that sees a boss entity,
// so a copy registered late still lands on the run's existing pool instead of
// starting a fresh one at full health.
export function noteBossEntity(
    levelScope: string | null | undefined,
    entity: any,
    estimateMaxHp: (entity: any, levelScope: string) => number
): BossAuthorityRecord | null {
    const scopeKey = normalizeScope(levelScope);
    const key = getBossAuthorityKey(scopeKey, entity);
    if (!key) {
        return null;
    }

    let scopeRecords = bossRecordsByScope.get(scopeKey);
    if (!scopeRecords) {
        scopeRecords = new Map<string, BossAuthorityRecord>();
        bossRecordsByScope.set(scopeKey, scopeRecords);
    }

    const level = getScopeRuntimeLevel(scopeKey, null, roundPositive(entity.level, 1));
    let record = scopeRecords.get(key);
    if (!record) {
        // Size the pool once, at the level the scope agreed on, and never
        // re-derive it: a pool that moves under an in-flight fight is a bar that
        // jumps on every screen.
        entity.level = level;
        const maxHp = Math.max(
            1,
            roundPositive(entity.maxHp) ||
                roundPositive(estimateMaxHp(entity, scopeKey)) ||
                roundPositive(entity.hp, 1)
        );
        record = {
            levelScope: scopeKey,
            canonicalName: key,
            level,
            maxHp,
            hp: maxHp,
            dead: false,
            deadAt: 0,
            reportedDamageByToken: new Map<number, number>()
        };
        scopeRecords.set(key, record);
    }

    applyBossAuthorityToEntity(record, entity);
    return record;
}

// Projects the record onto one client copy.
//
// Deliberately narrow. The health paths already resolve and converge hp/maxHp
// across copies, and a second writer for those numbers only fights the first —
// so the record follows their arithmetic rather than overriding it. What it
// does own is the level every copy is scaled at, and the fact of the death,
// because those are the two things that were previously decided per viewer.
export function applyBossAuthorityToEntity(record: BossAuthorityRecord, entity: any): void {
    if (!entity || typeof entity !== 'object') {
        return;
    }

    entity.level = record.level;
    entity.bossAuthorityKey = record.canonicalName;
    if (record.dead) {
        entity.dead = true;
        entity.playerDamageContributed = true;
        entity.clientDefeatVerified = true;
    }
}

// Applies one client's reported damage against the shared pool.
//
// Reports are accumulated per token rather than subtracted directly: clients
// re-report the same running total as their local sim catches up, and adding
// those deltas blindly drained the pool several times over in a full party.
export function reportBossDamage(
    levelScope: string | null | undefined,
    entity: any,
    token: number,
    damage: number
): { record: BossAuthorityRecord; hp: number; killed: boolean } | null {
    const record = getBossAuthorityRecord(levelScope, entity);
    if (!record) {
        return null;
    }

    const appliedDamage = Math.max(0, Math.round(Number(damage) || 0));
    const sourceToken = Math.max(0, Math.round(Number(token) || 0));
    if (appliedDamage > 0) {
        const previous = Math.max(0, Math.round(Number(record.reportedDamageByToken.get(sourceToken) ?? 0)));
        record.reportedDamageByToken.set(sourceToken, Math.min(record.maxHp, previous + appliedDamage));
    }

    let totalReported = 0;
    for (const reported of record.reportedDamageByToken.values()) {
        totalReported += Math.max(0, Math.round(Number(reported) || 0));
    }

    const wasDead = record.dead;
    record.hp = Math.max(0, record.maxHp - Math.min(record.maxHp, totalReported));
    if (record.hp <= 0 && !record.dead) {
        record.dead = true;
        record.deadAt = Date.now();
    }

    applyBossAuthorityToEntity(record, entity);
    return { record, hp: record.hp, killed: record.dead && !wasDead };
}

// The health paths stay the arithmetic; the record just remembers what they
// decided, so the ledger clamps against a real pool and the death reaches
// viewers the copy sweep never matched.
export function adoptBossAuthorityHealth(
    levelScope: string | null | undefined,
    entity: any,
    currentHp: number,
    maxHp: number
): BossAuthorityRecord | null {
    const record = getBossAuthorityRecord(levelScope, entity);
    if (!record) {
        return null;
    }

    record.maxHp = Math.max(1, Math.round(Number(maxHp) || record.maxHp));
    record.hp = Math.max(0, Math.min(record.maxHp, Math.round(Number(currentHp) || 0)));
    if (record.hp <= 0 && !record.dead) {
        record.dead = true;
        record.deadAt = Date.now();
    }
    return record;
}

// Pushes the record onto every copy of this boss the server holds — the shared
// level map plus each session's own entity map. Call after any change so a
// viewer that never fired a shot still sees the bar move.
export function syncBossAuthorityCopies(
    levelScope: string | null | undefined,
    record: BossAuthorityRecord
): number {
    const scopeKey = normalizeScope(levelScope);
    if (!scopeKey) {
        return 0;
    }

    let synced = 0;
    const stamp = (candidate: any): void => {
        // Cheap rejects first. Resolving a canonical boss name clones a catalog
        // entry, and this sweep runs on every boss health tick across every
        // session's entity map — the overwhelming majority of what it walks is
        // trash mobs and props.
        if (!candidate || candidate.isPlayer || Number(candidate.team ?? 0) !== ENEMY_TEAM) {
            return;
        }
        if (candidate.bossAuthorityKey !== undefined && candidate.bossAuthorityKey !== record.canonicalName) {
            return;
        }
        if (
            candidate.bossAuthorityKey !== record.canonicalName &&
            getBossAuthorityKey(scopeKey, candidate) !== record.canonicalName
        ) {
            return;
        }
        applyBossAuthorityToEntity(record, candidate);
        synced++;
    };

    for (const candidate of GlobalState.levelEntities.get(scopeKey)?.values() ?? []) {
        stamp(candidate);
    }
    for (const session of GlobalState.getSessionsInLevelScope(scopeKey)) {
        for (const candidate of session.entities?.values() ?? []) {
            stamp(candidate);
        }
    }

    return synced;
}

export function isBossAuthorityDead(levelScope: string | null | undefined, entity: any): boolean {
    return Boolean(getBossAuthorityRecord(levelScope, entity)?.dead);
}

// True once the scope owns this boss's pool, which is the condition the combat
// paths use to decide they may commit the kill themselves instead of waiting
// for one client's defeat signal.
export function hasBossAuthorityPool(levelScope: string | null | undefined, entity: any): boolean {
    return Boolean(getBossAuthorityRecord(levelScope, entity));
}

export function getBossAuthorityRecordsForScope(
    levelScope: string | null | undefined
): BossAuthorityRecord[] {
    return [...(bossRecordsByScope.get(normalizeScope(levelScope))?.values() ?? [])];
}

export function clearBossAuthority(levelScope: string | null | undefined): void {
    const scopeKey = normalizeScope(levelScope);
    if (!scopeKey) {
        return;
    }

    bossRecordsByScope.delete(scopeKey);
    clearScopeRuntimeLevel(scopeKey);
}

export function clearAllBossAuthority(): void {
    bossRecordsByScope.clear();
}
