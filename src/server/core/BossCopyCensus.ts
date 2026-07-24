import { DungeonCompletionConditions } from './DungeonCompletionConditions';
import { GlobalState } from './GlobalState';
import { getClientLevelScope, getScopeLevelName } from './LevelScope';
import { isRoomBossEntity } from './RoomBossState';

// Dread Goblin Hideout keeps a second Tag Ugo standing through the whole boss
// scene: it never moves, it keeps every debuff it was ever hit with, and it only
// disappears when the rank plate opens. Every dedupe guard we have is anchored on
// the shared scope map, so a copy that lives only in one player's local entity
// map is invisible to all of them — and invisible in the logs too.
//
// This module is that missing view: one line that names every entity any session
// currently believes is the boss, in the shared map *and* in each client's local
// map, with the two facts that identify the stale one (it does not move, and its
// buff list only grows). Sample it at scene entry, at the cutscene edges and at
// the boss death, and the copy's origin is readable straight off the timeline.

export type BossCopyLocation = 'scope' | 'local';

export type BossCopySnapshot = {
    where: BossCopyLocation;
    // Empty for the shared map; the owning character for a local copy.
    viewer: string;
    viewerToken: number;
    id: number;
    name: string;
    canonicalBoss: string;
    markedRoomBoss: boolean;
    clientSpawned: boolean;
    hybridCanonical: boolean;
    ownerToken: number;
    roomId: number;
    roomBossRoomId: number;
    hp: number;
    maxHp: number;
    dead: boolean;
    untargetable: boolean;
    x: number;
    y: number;
    v: number;
    // Local copies only: which id this one is aliased onto, and whether the
    // client is still told about it. A copy with no alias is an orphan visual.
    aliasTarget: number;
    known: boolean;
    buffs: string[];
    lastCombatActivityAt: number;
};

export function isBossCopyDiagEnabled(): boolean {
    return String(process.env.DUNGEON_DIAG ?? '1').trim() !== '0';
}

function toInt(value: unknown, fallback: number = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function listBuffs(entity: any): string[] {
    const buffs = entity?.activeBuffs;
    if (!buffs || typeof buffs !== 'object') {
        return [];
    }
    return Array.isArray(buffs)
        ? buffs.map((buff: any) => String(buff?.name ?? buff?.id ?? buff ?? '')).filter(Boolean)
        : Object.keys(buffs);
}

function snapshotEntity(
    levelScope: string,
    levelName: string,
    entity: any,
    entityId: number,
    where: BossCopyLocation,
    viewerName: string,
    viewerToken: number,
    aliasTarget: number,
    known: boolean
): BossCopySnapshot {
    return {
        where,
        viewer: viewerName,
        viewerToken,
        id: entityId,
        name: String(entity?.name ?? ''),
        canonicalBoss: DungeonCompletionConditions.getCanonicalBossName(levelName, entity, levelScope),
        markedRoomBoss: isRoomBossEntity(levelScope, entity),
        clientSpawned: Boolean(entity?.clientSpawned),
        hybridCanonical: Boolean(entity?.hybridCanonicalHostile),
        ownerToken: toInt(entity?.ownerToken),
        roomId: toInt(entity?.roomId, -1),
        roomBossRoomId: toInt(entity?.roomBossRoomId, -1),
        hp: toInt(entity?.hp, -1),
        maxHp: toInt(entity?.maxHp, -1),
        dead: Boolean(entity?.dead),
        untargetable: Boolean(entity?.untargetable),
        x: toInt(entity?.x, -1),
        y: toInt(entity?.y, -1),
        v: toInt(entity?.v),
        aliasTarget,
        known,
        buffs: listBuffs(entity),
        lastCombatActivityAt: toInt(entity?.lastCombatActivityAt)
    };
}

function normalizeIdentity(value: unknown): string {
    return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Every name that identifies this dungeon's boss, canonical names and aliases
// alike. Built once per census so the scan does not re-clone the condition for
// each of the level's entities.
export function getBossIdentityKeys(levelName: string): ReadonlySet<string> {
    const keys = new Set<string>();
    const condition = DungeonCompletionConditions.get(levelName);
    if (!condition || condition.mode !== 'bosses') {
        return keys;
    }

    for (const group of condition.bossGroups ?? []) {
        for (const bossName of group) {
            keys.add(normalizeIdentity(bossName));
        }
    }
    for (const alias of Object.keys(condition.bossAliases ?? {})) {
        keys.add(normalizeIdentity(alias));
    }
    keys.delete('');
    return keys;
}

// Any entity a name-matcher would call this dungeon's boss, whether or not the
// completion rules would currently accept it. getCanonicalBossName can reject a
// copy for missing a room-boss marker, and that rejection is exactly the case
// that hides the stale Tag Ugo — so match on the raw boss names as well.
export function looksLikeDungeonBoss(entity: any, bossKeys: ReadonlySet<string>): boolean {
    if (!entity || typeof entity !== 'object' || entity.isPlayer || bossKeys.size === 0) {
        return false;
    }

    for (const candidate of [
        entity?.name,
        entity?.EntName,
        entity?.entName,
        entity?.characterName,
        entity?.character_name,
        entity?.displayName,
        entity?.DisplayName,
        entity?.roomBossName
    ]) {
        if (bossKeys.has(normalizeIdentity(candidate))) {
            return true;
        }
    }

    return false;
}

export function collectBossCopies(levelScope: string, levelName: string = ''): BossCopySnapshot[] {
    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return [];
    }

    const resolvedLevel = String(levelName ?? '').trim() || getScopeLevelName(scopeKey);
    const bossKeys = getBossIdentityKeys(resolvedLevel);
    const copies: BossCopySnapshot[] = [];
    if (bossKeys.size === 0) {
        return copies;
    }

    for (const [entityId, entity] of GlobalState.levelEntities.get(scopeKey)?.entries() ?? []) {
        if (!looksLikeDungeonBoss(entity, bossKeys)) {
            continue;
        }
        copies.push(snapshotEntity(scopeKey, resolvedLevel, entity, toInt(entityId), 'scope', '', 0, 0, false));
    }

    for (const session of GlobalState.sessionsByToken.values()) {
        if (!session.playerSpawned || getClientLevelScope(session) !== scopeKey) {
            continue;
        }
        for (const [entityId, entity] of session.entities?.entries() ?? []) {
            if (!looksLikeDungeonBoss(entity, bossKeys)) {
                continue;
            }
            const localId = toInt(entityId);
            copies.push(snapshotEntity(
                scopeKey,
                resolvedLevel,
                entity,
                localId,
                'local',
                String(session.character?.name ?? ''),
                toInt(session.token),
                toInt(session.entityIdAliases?.get(localId)),
                Boolean(session.knownEntityIds?.has(localId))
            ));
        }
    }

    return copies;
}

// One census line. `phase` is the moment being sampled ("roomBossInfo:before",
// "cutsceneEnd", "bossDeath:after", ...) so consecutive lines read as a timeline:
// the copy that holds identical x/y across every phase while its buff list grows
// is the one to remove.
export function logBossCopyCensus(
    phase: string,
    levelScope: string,
    levelName: string = '',
    extra: Record<string, unknown> = {}
): void {
    if (!isBossCopyDiagEnabled()) {
        return;
    }

    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return;
    }

    const resolvedLevel = String(levelName ?? '').trim() || getScopeLevelName(scopeKey);
    const copies = collectBossCopies(scopeKey, resolvedLevel);
    const localByViewer = new Map<string, number>();
    for (const copy of copies) {
        if (copy.where !== 'local') {
            continue;
        }
        localByViewer.set(copy.viewer, (localByViewer.get(copy.viewer) ?? 0) + 1);
    }

    try {
        console.log(`[DUNGEON-DIAG] bossCopyCensus ${JSON.stringify({
            phase,
            level: resolvedLevel,
            scope: scopeKey,
            scopeCopies: copies.filter((copy) => copy.where === 'scope').length,
            // More than one local copy for a single viewer means that player is
            // rendering the stale Tag Ugo next to the real one right now.
            localCopiesByViewer: Object.fromEntries(localByViewer),
            copies,
            ...extra
        })}`);
    } catch {
        console.log(`[DUNGEON-DIAG] bossCopyCensus ${phase} <unserializable>`);
    }
}
