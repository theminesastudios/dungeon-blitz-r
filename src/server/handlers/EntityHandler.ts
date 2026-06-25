import { NpcLoader, NpcDef } from '../data/NpcLoader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { Client, clearClientSpawnFallbackTimer, createKeepTutorialState } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { DebugConfig } from '../core/Debug';
import { DeadHostileTombstone, GlobalState } from '../core/GlobalState';
import { Entity, EntityProps, EntityState, EntityTeam } from '../core/Entity';
import { LevelConfig } from '../core/LevelConfig';
import { GameData } from '../core/GameData';
import { PetHandler } from './PetHandler';
import { BuildingHandler } from './BuildingHandler';
import { MissionHandler } from './MissionHandler';
import { noteDungeonRunBossCutscene, noteDungeonRunEntitySeen } from '../core/DungeonRunStats';
import { areClientsInSameParty, getPartyIdForClient, isClientPartyLeader, sharesRoomIds } from '../core/PartySync';
import { areClientsInSameLevelScope, getClientLevelScope, getLevelScopeKey, getScopeLevelName } from '../core/LevelScope';
import { getPartyRuntimeLevelForClient } from '../core/RuntimeLevel';
import { markRoomBossEntity } from '../core/RoomBossState';
import { logJcMini1Authority } from '../utils/JcMini1AuthorityLog';

export class EntityHandler {
    private static readonly CLIENT_SPAWN_LEVELS = new Set<string>([
        'CraftTownTutorial',
        'CraftTown',
        'NewbieRoad',
        'NewbieRoadHard',
        'GoblinRiverDungeon',
        'GoblinRiverDungeonHard',
        'SwampRoadNorth',
        'SwampRoadNorthHard',
        'SwampRoadConnection',
        'SwampRoadConnectionHard',
        'BridgeTown',
        'BridgeTownHard',
        'CemeteryHill',
        'CemeteryHillHard',
        'OldMineMountain',
        'OldMineMountainHard',
        'EmeraldGlades',
        'EmeraldGladesHard',
        'Castle',
        'CastleHard',
        'ShazariDesert',
        'ShazariDesertHard',
        'JadeCity',
        'JadeCityHard'
    ]);
    private static readonly MOUNT_SYNC_RETRY_DELAYS_MS = [0, 300, 1200, 2500, 4000];
    private static readonly CLIENT_SPAWN_JOINER_SEED_DELAYS_MS = [2500, 4500];
    private static readonly GOBLIN_RIVER_ROOM_SYNC_SKIP_LEVELS = new Set<string>([
        'TutorialDungeon',
        'GoblinRiverDungeon',
        'GoblinRiverDungeonHard'
    ]);
    private static readonly SERVER_AUTHORITY_HOSTILE_LEVELS = new Set<string>([
        'AC_Mission1',
        'JC_Mini1Hard'
    ]);
    private static readonly FIRST_SIGHT_SERVER_AUTHORITY_HOSTILE_LEVELS = new Set<string>([
        'AC_Mission1'
    ]);
    private static readonly CANONICAL_VISIBLE_PROXY_MATCH_MAX_DISTANCE_SQ = 400 * 400;
    static readonly SERVER_AUTHORITY_ENTITY_LEVEL = 50;
    private static readonly HOSTILE_BASE_HITPOINTS = [
        100, 4920, 5580, 6020, 6520, 7040, 7580, 8180, 8800, 9480, 10180, 10960, 11740, 12640, 13540, 14540,
        15560, 16660, 17860, 19120, 20440, 21860, 23360, 24960, 26680, 28460, 30380, 32420, 34580, 36900, 39320,
        41920, 44660, 47560, 50660, 53940, 57420, 61080, 64980, 69120, 73520, 78160, 83100, 88300, 93820, 99700,
        105880, 112460, 119400, 126760, 134560
    ];
    private static serverAuthoritySeededScopes = new Set<string>();
    private static serverAuthorityDestroyedIdsByScope = new Map<string, Set<number>>();
    private static serverAuthorityDestroyedFingerprintsByScope = new Map<string, Set<string>>();
    private static craftTownTutorialHelperIdsCache: Set<number> | null = null;

    private static normalizeIdentityName(value: unknown): string {
        return String(value ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '');
    }

    private static getCraftTownTutorialAuthoredHelperIds(): Set<number> {
        if (EntityHandler.craftTownTutorialHelperIdsCache) {
            return new Set(EntityHandler.craftTownTutorialHelperIdsCache);
        }

        const helperIds = new Set<number>(
            NpcLoader.getRawNpcsForLevel('CraftTownTutorial')
                .filter((npc) =>
                    String(npc?.name ?? '') === 'GoblinDagger' &&
                    String(npc?.DramaAnim ?? '') === 'Board' &&
                    Number(npc?.team ?? 0) === 2
                )
                .map((npc) => Number(npc.id ?? 0))
                .filter((id) => id > 0)
        );

        EntityHandler.craftTownTutorialHelperIdsCache = helperIds;
        return new Set(helperIds);
    }

    private static usesClientSpawn(levelName: string): boolean {
        return EntityHandler.CLIENT_SPAWN_LEVELS.has(levelName);
    }

    static usesServerAuthorityHostiles(levelName: string | null | undefined): boolean {
        return EntityHandler.SERVER_AUTHORITY_HOSTILE_LEVELS.has(LevelConfig.normalizeLevelName(levelName));
    }

    static usesCanonicalVisibleServerAuthorityHostiles(levelName: string | null | undefined): boolean {
        return EntityHandler.FIRST_SIGHT_SERVER_AUTHORITY_HOSTILE_LEVELS.has(
            LevelConfig.normalizeLevelName(getScopeLevelName(String(levelName ?? '')))
        );
    }

    private static getServerAuthorityDestroyedIds(levelScope: string): Set<number> {
        let destroyedIds = EntityHandler.serverAuthorityDestroyedIdsByScope.get(levelScope);
        if (!destroyedIds) {
            destroyedIds = new Set<number>();
            EntityHandler.serverAuthorityDestroyedIdsByScope.set(levelScope, destroyedIds);
        }

        return destroyedIds;
    }

    private static getServerAuthorityDestroyedFingerprints(levelScope: string): Set<string> {
        let destroyedFingerprints = EntityHandler.serverAuthorityDestroyedFingerprintsByScope.get(levelScope);
        if (!destroyedFingerprints) {
            destroyedFingerprints = new Set<string>();
            EntityHandler.serverAuthorityDestroyedFingerprintsByScope.set(levelScope, destroyedFingerprints);
        }

        return destroyedFingerprints;
    }

    private static getServerAuthorityHostileFingerprint(entity: any): string {
        if (!entity || entity.isPlayer || Number(entity.team ?? 0) !== EntityTeam.ENEMY) {
            return '';
        }

        const name = EntityHandler.normalizeServerAuthorityProxyName(
            entity.name ?? entity.EntName ?? entity.entName ?? entity.characterName ?? entity.character_name
        );
        if (!name) {
            return '';
        }

        const roomId = Number.isFinite(Number(entity.roomId)) ? Math.round(Number(entity.roomId)) : -1;
        const x = Number.isFinite(Number(entity.x)) ? Math.round(Number(entity.x) / 100) : 0;
        const y = Number.isFinite(Number(entity.y)) ? Math.round(Number(entity.y) / 100) : 0;
        return `${name}:${roomId}:${x}:${y}`;
    }

    static noteServerAuthorityHostileDestroyed(levelScope: string, entityId: number, entity: any = null, killerToken: number = 0): void {
        const scopeKey = String(levelScope ?? '').trim();
        const id = Math.max(0, Math.round(Number(entityId) || 0));
        if (!scopeKey || id <= 0 || !EntityHandler.usesServerAuthorityHostiles(getScopeLevelName(scopeKey))) {
            return;
        }

        EntityHandler.getServerAuthorityDestroyedIds(scopeKey).add(id);
        const fingerprint = EntityHandler.getServerAuthorityHostileFingerprint(entity);
        if (fingerprint) {
            EntityHandler.getServerAuthorityDestroyedFingerprints(scopeKey).add(fingerprint);
        }
        if (entity) {
            EntityHandler.upsertDeadServerAuthorityHostileTombstone(scopeKey, entity, 'note_destroyed', killerToken);
        }
    }

    static getDeadServerAuthorityHostileTombstones(levelScope: string): Map<string, DeadHostileTombstone> {
        const scopeKey = String(levelScope ?? '').trim();
        let tombstones = GlobalState.deadServerAuthorityHostilesByScope.get(scopeKey);
        if (!tombstones) {
            tombstones = new Map<string, DeadHostileTombstone>();
            GlobalState.deadServerAuthorityHostilesByScope.set(scopeKey, tombstones);
        }

        return tombstones;
    }

    static clearDeadServerAuthorityHostileTombstones(levelScope: string, reason: string): void {
        const scopeKey = String(levelScope ?? '').trim();
        if (!scopeKey) {
            return;
        }

        const count = GlobalState.deadServerAuthorityHostilesByScope.get(scopeKey)?.size ?? 0;
        GlobalState.deadServerAuthorityHostilesByScope.delete(scopeKey);
        console.log(`[MultiplayerSync][hostile-tombstones-clear] scope=${scopeKey} reason=${reason} count=${count}`);
    }

    static upsertDeadServerAuthorityHostileTombstone(
        levelScope: string,
        entity: any,
        reason: string,
        killerToken: number = 0
    ): DeadHostileTombstone | null {
        const scopeKey = String(levelScope ?? '').trim();
        const canonicalId = Math.max(0, Math.round(Number(entity?.id ?? entity?.canonicalId ?? 0)));
        if (!scopeKey || canonicalId <= 0 || !EntityHandler.isServerAuthorityHostileEntity(scopeKey, entity)) {
            return null;
        }

        const spawnKey = String(entity.spawnKey || EntityHandler.getHostileSpawnKey(scopeKey, entity));
        entity.spawnKey = spawnKey;
        const tombstones = EntityHandler.getDeadServerAuthorityHostileTombstones(scopeKey);
        const existing = tombstones.get(spawnKey);
        const levelName = getScopeLevelName(scopeKey);
        const deathFinalizedAt = Math.max(0, Math.round(Number(entity.deathFinalizedAt ?? Date.now())));
        const tombstone: DeadHostileTombstone = {
            canonicalId,
            spawnKey,
            levelScope: scopeKey,
            levelName,
            roomId: Math.max(-1, Math.round(Number(entity.roomId ?? -1))),
            enemyType: String(entity.entType ?? entity.EntType ?? entity.name ?? entity.EntName ?? ''),
            name: String(entity.name ?? entity.EntName ?? entity.entName ?? ''),
            x: Math.round(Number(entity.x ?? entity.physPosX ?? 0) || 0),
            y: Math.round(Number(entity.y ?? entity.physPosY ?? 0) || 0),
            killedAt: Math.max(0, Math.round(Number(existing?.killedAt ?? deathFinalizedAt))),
            killerToken: Math.max(0, Math.round(Number(killerToken || existing?.killerToken || 0))),
            lootDropNonce: String(entity.lootDropNonce ?? existing?.lootDropNonce ?? ''),
            deathFinalizedAt,
            dead: true,
            destroyed: true,
            deathVersion: Math.max(1, Math.round(Number(entity.deathVersion ?? existing?.deathVersion ?? 1)))
        };
        tombstones.set(spawnKey, tombstone);
        EntityHandler.getServerAuthorityDestroyedIds(scopeKey).add(canonicalId);
        const fingerprint = EntityHandler.getServerAuthorityHostileFingerprint(entity);
        if (fingerprint) {
            EntityHandler.getServerAuthorityDestroyedFingerprints(scopeKey).add(fingerprint);
        }

        console.log(
            `[MultiplayerSync][hostile-tombstone-create] scope=${scopeKey} canonicalId=${canonicalId} spawnKey=${spawnKey} name=${String(tombstone.name).replace(/\s+/g, '_')} killer=${tombstone.killerToken} deathVersion=${tombstone.deathVersion}`
        );
        return tombstone;
    }

    static findDeadServerAuthorityHostileTombstone(levelScope: string, entity: any): DeadHostileTombstone | null {
        const scopeKey = String(levelScope ?? '').trim();
        if (!scopeKey || !entity) {
            return null;
        }

        const tombstones = GlobalState.deadServerAuthorityHostilesByScope.get(scopeKey);
        if (!tombstones || tombstones.size === 0) {
            return null;
        }

        const spawnKey = String(entity.spawnKey || EntityHandler.getHostileSpawnKey(scopeKey, entity));
        const exact = tombstones.get(spawnKey);
        if (exact) {
            return exact;
        }

        const fingerprint = EntityHandler.getServerAuthorityHostileFingerprint(entity);
        if (!fingerprint) {
            return null;
        }

        for (const tombstone of tombstones.values()) {
            const tombstoneFingerprint = EntityHandler.getServerAuthorityHostileFingerprint({
                name: tombstone.name || tombstone.enemyType,
                team: EntityTeam.ENEMY,
                roomId: tombstone.roomId,
                x: tombstone.x,
                y: tombstone.y
            });
            if (tombstoneFingerprint === fingerprint) {
                return tombstone;
            }
        }

        return null;
    }

    private static getHostileBaseHpForLevel(level: number): number {
        const maxIndex = EntityHandler.HOSTILE_BASE_HITPOINTS.length - 1;
        const clampedLevel = Math.max(1, Math.min(maxIndex, Math.floor(Number(level) || 1)));
        return EntityHandler.HOSTILE_BASE_HITPOINTS[clampedLevel];
    }

    static estimateServerAuthorityHostileMaxHp(entity: any): number {
        const entType = GameData.getEntType(String(entity?.name ?? '')) ?? {};
        const hitPointScale = Number(entity?.HitPoints ?? entity?.hitPoints ?? entType?.HitPoints ?? NaN);
        const baseHp = EntityHandler.getHostileBaseHpForLevel(EntityHandler.SERVER_AUTHORITY_ENTITY_LEVEL);
        if (!Number.isFinite(hitPointScale) || hitPointScale <= 0) {
            return Math.max(1, baseHp);
        }

        return Math.max(1, Math.round(baseHp * hitPointScale));
    }

    static isServerAuthorityHostileEntity(levelNameOrScope: string | null | undefined, entity: any): boolean {
        return EntityHandler.usesServerAuthorityHostiles(getScopeLevelName(String(levelNameOrScope ?? ''))) &&
            Boolean(entity) &&
            !Boolean(entity?.isPlayer) &&
            !Boolean(entity?.clientSpawned) &&
            Number(entity?.team ?? 0) === EntityTeam.ENEMY;
    }

    static normalizeServerAuthorityHostileState(levelNameOrScope: string | null | undefined, entity: any): void {
        if (!EntityHandler.isServerAuthorityHostileEntity(levelNameOrScope, entity)) {
            return;
        }

        const oldMaxHp = Math.max(0, Math.round(Number(entity.maxHp ?? 0)));
        const oldHp = Math.max(0, Math.round(Number(entity.hp ?? (oldMaxHp || 0))));
        const oldDamage = oldMaxHp > 0 ? Math.max(0, oldMaxHp - oldHp) : 0;
        const maxHp = EntityHandler.estimateServerAuthorityHostileMaxHp(entity);
        const dead = Boolean(entity.dead) ||
            Boolean(entity.destroyed) ||
            Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD ||
            (Number.isFinite(Number(entity.hp)) && Math.round(Number(entity.hp)) <= 0);
        const hp = dead ? 0 : Math.max(1, Math.min(maxHp, maxHp - oldDamage));
        const healthDelta = hp - maxHp;

        entity.level = EntityHandler.SERVER_AUTHORITY_ENTITY_LEVEL;
        entity.maxHp = maxHp;
        entity.hp = hp;
        entity.healthDelta = healthDelta;
        entity.health_delta = healthDelta;
        entity.dead = dead;
        entity.destroyed = dead ? Boolean(entity.destroyed) : false;
        entity.entState = dead ? EntityState.DEAD : Number(entity.entState ?? EntityState.SLEEP);
        entity.clientSpawned = false;
    }

    private static createServerAuthorityEntityFromNpc(client: Client, levelName: string, npc: NpcDef): EntityProps {
        const entityProps = {
            ...Entity.fromNpc(npc),
            clientSpawned: false,
            boss: Boolean(npc.boss),
            roomBoss: Boolean(npc.roomBoss),
            isRoomBoss: Boolean(npc.isRoomBoss ?? npc.roomBoss),
            roomBossName: String(npc.roomBossName ?? npc.displayName ?? ''),
            displayName: String(npc.displayName ?? npc.roomBossName ?? ''),
            sourceRoom: String(npc.sourceRoom ?? '')
        } as EntityProps & Record<string, unknown>;
        EntityHandler.applyRuntimeDungeonEntityLevel(client, levelName, entityProps);
        return entityProps;
    }

    private static seedServerAuthorityHostiles(client: Client, levelName: string, levelMap: Map<number, any>): void {
        if (!EntityHandler.usesServerAuthorityHostiles(levelName)) {
            return;
        }

        const levelScope = getLevelScopeKey(levelName, client.levelInstanceId);
        if (!levelScope || EntityHandler.serverAuthoritySeededScopes.has(levelScope)) {
            return;
        }

        const destroyedIds = EntityHandler.getServerAuthorityDestroyedIds(levelScope);
        for (const npc of NpcLoader.getNpcsForLevel(levelName)) {
            const npcId = Math.max(0, Math.round(Number(npc.id ?? 0)));
            if (npcId <= 0 || destroyedIds.has(npcId) || levelMap.has(npcId)) {
                continue;
            }

            const entityProps = EntityHandler.createServerAuthorityEntityFromNpc(client, levelName, npc);
            (entityProps as any).spawnKey = (entityProps as any).spawnKey || EntityHandler.getHostileSpawnKey(levelScope, entityProps);
            if (EntityHandler.findDeadServerAuthorityHostileTombstone(levelScope, entityProps)) {
                continue;
            }
            levelMap.set(npcId, entityProps);
            logJcMini1Authority('seed_server_hostile', {
                entityId: npcId,
                name: entityProps.name,
                team: entityProps.team,
                roomId: entityProps.roomId,
                x: entityProps.x,
                y: entityProps.y,
                entityLevel: entityProps.level,
                hp: Math.round(Number((entityProps as any).hp ?? 0)),
                maxHp: Math.round(Number((entityProps as any).maxHp ?? 0)),
                dead: Boolean((entityProps as any).dead),
                entState: entityProps.entState,
                scope: levelScope,
                character: client.character?.name ?? '',
                token: client.token
            });
        }

        EntityHandler.serverAuthoritySeededScopes.add(levelScope);
    }

    private static hasOtherActiveSessionInScope(client: Client, levelScope: string): boolean {
        for (const session of GlobalState.sessionsByToken.values()) {
            if (
                session !== client &&
                session.playerSpawned &&
                !session.socket?.destroyed &&
                getClientLevelScope(session) === levelScope
            ) {
                return true;
            }
        }

        return false;
    }

    private static selectJcMini1PartyScopeAnchor(client: Client, levelName: string): Client | null {
        if (!EntityHandler.usesServerAuthorityHostiles(levelName) || getPartyIdForClient(client) <= 0) {
            return null;
        }

        let bestSession: Client | null = null;
        let bestStartedAt = Number.POSITIVE_INFINITY;
        for (const session of GlobalState.sessionsByToken.values()) {
            if (
                session === client ||
                !session.playerSpawned ||
                !session.character ||
                !GlobalState.isSessionOpen(session) ||
                LevelConfig.normalizeLevelName(session.currentLevel) !== levelName ||
                !areClientsInSameParty(client, session)
            ) {
                continue;
            }

            const startedAt = Math.max(0, Math.round(Number(session.syncAnchorStartedAt ?? 0) || 0));
            const comparableStartedAt = startedAt > 0 ? startedAt : Number.MAX_SAFE_INTEGER;
            if (
                !bestSession ||
                comparableStartedAt < bestStartedAt ||
                (comparableStartedAt === bestStartedAt && session.token < bestSession.token)
            ) {
                bestSession = session;
                bestStartedAt = comparableStartedAt;
            }
        }

        return bestSession;
    }

    private static moveClientOwnedEntitiesBetweenScopes(client: Client, oldScope: string, newScope: string): void {
        if (!oldScope || !newScope || oldScope === newScope) {
            return;
        }

        const oldMap = GlobalState.levelEntities.get(oldScope);
        if (!oldMap) {
            return;
        }

        let newMap = GlobalState.levelEntities.get(newScope);
        if (!newMap) {
            newMap = new Map<number, any>();
            GlobalState.levelEntities.set(newScope, newMap);
        }

        let moved = 0;
        const charNameNorm = EntityHandler.normalizeIdentityName(client.character?.name);
        for (const [entityId, entity] of Array.from(oldMap.entries())) {
            const isOwnedPlayer = Boolean(entity?.isPlayer) && (
                (client.clientEntID > 0 && entityId === client.clientEntID) ||
                (charNameNorm && EntityHandler.normalizeIdentityName(entity?.name) === charNameNorm)
            );
            const isOwnedClientSpawn = Boolean(entity?.clientSpawned) && Number(entity?.ownerToken ?? 0) === client.token;
            if (!isOwnedPlayer && !isOwnedClientSpawn) {
                continue;
            }

            oldMap.delete(entityId);
            newMap.set(entityId, entity);
            moved++;
        }

        if (oldMap.size === 0) {
            GlobalState.levelEntities.delete(oldScope);
        }

        if (moved > 0) {
            logJcMini1Authority('party_scope_entity_migrate', {
                oldScope,
                newScope,
                moved,
                viewer: client.character?.name ?? '',
                viewerToken: client.token,
                clientEntID: client.clientEntID
            });
        }
    }

    private static emitJcMini1PartyScopeSnapshot(client: Client, levelName: string, reason: string): void {
        if (!EntityHandler.usesServerAuthorityHostiles(levelName) || getPartyIdForClient(client) <= 0) {
            return;
        }

        const partyMembers: any[] = [];
        for (const session of GlobalState.sessionsByToken.values()) {
            if (!session.character || !areClientsInSameParty(client, session)) {
                continue;
            }

            partyMembers.push({
                token: session.token,
                name: session.character.name,
                level: session.currentLevel,
                levelInstanceId: session.levelInstanceId,
                scope: getClientLevelScope(session),
                roomId: session.currentRoomId,
                playerSpawned: Boolean(session.playerSpawned),
                hp: Math.round(Number(session.authoritativeCurrentHp ?? 0)),
                maxHp: Math.round(Number(session.authoritativeMaxHp ?? 0)),
                proxyCount: Array.from(session.entities?.values?.() ?? [])
                    .filter((entity: any) => Number(entity?.team ?? 0) === EntityTeam.ENEMY && Number(entity?.canonicalEntityId ?? 0) > 0)
                    .length
            });
        }

        logJcMini1Authority('party_scope_snapshot', {
            reason,
            scope: getLevelScopeKey(levelName, client.levelInstanceId),
            partyId: getPartyIdForClient(client),
            viewer: client.character?.name ?? '',
            viewerToken: client.token,
            partyMembers
        });
    }

    static ensureJcMini1PartySharedScope(client: Client, rawLevelName: string | null | undefined, reason: string): string {
        const levelName = LevelConfig.normalizeLevelName(rawLevelName) || '';
        if (!EntityHandler.usesServerAuthorityHostiles(levelName)) {
            return getLevelScopeKey(rawLevelName, client.levelInstanceId);
        }

        const oldInstanceId = String(client.levelInstanceId ?? '');
        const oldScope = getLevelScopeKey(levelName, oldInstanceId);
        const anchor = EntityHandler.selectJcMini1PartyScopeAnchor(client, levelName);
        const anchorInstanceId = anchor
            ? (String(anchor.levelInstanceId ?? '').trim() || (anchor.token > 0 ? String(anchor.token) : ''))
            : '';
        const targetInstanceId = anchorInstanceId || oldInstanceId.trim() || (client.token > 0 ? String(client.token) : '');
        if (!targetInstanceId) {
            EntityHandler.emitJcMini1PartyScopeSnapshot(client, levelName, reason);
            return oldScope;
        }

        if (anchor && String(anchor.levelInstanceId ?? '') !== targetInstanceId) {
            const anchorOldScope = getLevelScopeKey(levelName, anchor.levelInstanceId);
            anchor.levelInstanceId = targetInstanceId;
            EntityHandler.moveClientOwnedEntitiesBetweenScopes(anchor, anchorOldScope, getLevelScopeKey(levelName, targetInstanceId));
        }

        const newScope = getLevelScopeKey(levelName, targetInstanceId);
        if (oldScope !== newScope || oldInstanceId !== targetInstanceId) {
            client.levelInstanceId = targetInstanceId;
            EntityHandler.moveClientOwnedEntitiesBetweenScopes(client, oldScope, newScope);
            logJcMini1Authority('party_scope_adopted', {
                reason,
                oldInstanceId,
                newInstanceId: targetInstanceId,
                oldScope,
                newScope,
                partyId: getPartyIdForClient(client),
                viewer: client.character?.name ?? '',
                viewerToken: client.token,
                anchor: anchor?.character?.name ?? '',
                anchorToken: anchor?.token ?? 0,
                anchorScope: anchor ? getClientLevelScope(anchor) : ''
            });
        }

        EntityHandler.emitJcMini1PartyScopeSnapshot(client, levelName, reason);
        return newScope;
    }

    private static clientKnowsServerAuthorityHostile(client: Client, levelMap: Map<number, any>): boolean {
        for (const [entityId, entity] of levelMap.entries()) {
            if (
                EntityHandler.isServerAuthorityHostileEntity(client.currentLevel, entity) &&
                (client.knownEntityIds?.has(entityId) || client.entities?.has(entityId))
            ) {
                return true;
            }
        }

        return false;
    }

    private static normalizeServerAuthorityProxyName(value: unknown): string {
        const normalized = EntityHandler.normalizeIdentityName(value);
        return normalized.endsWith('hard') ? normalized.slice(0, -4) : normalized;
    }

    private static findServerAuthorityProxyCanonical(
        levelName: string | null | undefined,
        levelMap: Map<number, any> | null,
        entity: any
    ): any | null {
        if (!EntityHandler.usesServerAuthorityHostiles(levelName) || !levelMap || !entity || entity.isPlayer) {
            return null;
        }

        const proxyName = EntityHandler.normalizeServerAuthorityProxyName(
            entity.name ?? entity.EntName ?? entity.entName ?? entity.characterName ?? entity.character_name
        );
        if (!proxyName) {
            return null;
        }

        let bestMatch: any | null = null;
        let bestDistanceSq = Number.POSITIVE_INFINITY;
        const proxyX = Number(entity.x ?? NaN);
        const proxyY = Number(entity.y ?? NaN);
        const hasProxyPosition = Number.isFinite(proxyX) && Number.isFinite(proxyY);

        const requireClosePosition = EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelName) && hasProxyPosition;
        for (const candidate of levelMap.values()) {
            if (!EntityHandler.isServerAuthorityHostileEntity(levelName, candidate)) {
                continue;
            }
            if (EntityHandler.normalizeServerAuthorityProxyName(candidate.name) !== proxyName) {
                continue;
            }

            const candidateX = Number(candidate.x ?? NaN);
            const candidateY = Number(candidate.y ?? NaN);
            const distanceSq = hasProxyPosition && Number.isFinite(candidateX) && Number.isFinite(candidateY)
                ? ((candidateX - proxyX) * (candidateX - proxyX)) + ((candidateY - proxyY) * (candidateY - proxyY))
                : 0;
            if (
                requireClosePosition &&
                Number.isFinite(candidateX) &&
                Number.isFinite(candidateY) &&
                distanceSq > EntityHandler.CANONICAL_VISIBLE_PROXY_MATCH_MAX_DISTANCE_SQ
            ) {
                continue;
            }
            if (distanceSq < bestDistanceSq) {
                bestDistanceSq = distanceSq;
                bestMatch = candidate;
            }
        }

        return bestMatch;
    }

    private static findExistingServerAuthorityProxyLocalId(
        client: Client,
        canonicalId: number,
        exceptLocalId: number
    ): number {
        const canonical = Math.max(0, Math.round(Number(canonicalId) || 0));
        const except = Math.max(0, Math.round(Number(exceptLocalId) || 0));
        if (canonical <= 0) {
            return 0;
        }

        for (const [localId, mappedCanonicalId] of (client.entityIdAliases ?? new Map<number, number>()).entries()) {
            const local = Math.max(0, Math.round(Number(localId) || 0));
            if (
                local > 0 &&
                local !== except &&
                Math.max(0, Math.round(Number(mappedCanonicalId) || 0)) === canonical &&
                client.entities.has(local)
            ) {
                return local;
            }
        }

        for (const [localId, localEntity] of client.entities.entries()) {
            const local = Math.max(0, Math.round(Number(localId) || 0));
            if (local <= 0 || local === except) {
                continue;
            }
            const localCanonical = Math.max(
                0,
                Math.round(Number(localEntity?.canonicalEntityId ?? localEntity?.sharedCanonicalId ?? 0) || 0)
            );
            if (localCanonical === canonical) {
                return local;
            }
        }

        return 0;
    }

    private static findClientLocalServerAuthorityProxyForCanonical(
        client: Client,
        levelName: string | null | undefined,
        canonical: any
    ): number {
        const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? 0) || 0));
        if (canonicalId <= 0) {
            return 0;
        }

        const canonicalName = EntityHandler.normalizeServerAuthorityProxyName(canonical?.name);
        if (!canonicalName) {
            return 0;
        }

        const canonicalX = Number(canonical?.x ?? NaN);
        const canonicalY = Number(canonical?.y ?? NaN);
        const hasCanonicalPosition = Number.isFinite(canonicalX) && Number.isFinite(canonicalY);
        const requireClosePosition = EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelName) && hasCanonicalPosition;
        let bestLocalId = 0;
        let bestDistanceSq = Number.POSITIVE_INFINITY;

        for (const [localId, localEntity] of client.entities.entries()) {
            const local = Math.max(0, Math.round(Number(localId) || 0));
            if (
                local <= 0 ||
                local === canonicalId ||
                localEntity?.isPlayer ||
                Number(localEntity?.team ?? 0) !== EntityTeam.ENEMY
            ) {
                continue;
            }
            if (EntityHandler.normalizeServerAuthorityProxyName(localEntity?.name) !== canonicalName) {
                continue;
            }

            const localX = Number(localEntity?.x ?? NaN);
            const localY = Number(localEntity?.y ?? NaN);
            const distanceSq = hasCanonicalPosition && Number.isFinite(localX) && Number.isFinite(localY)
                ? ((localX - canonicalX) * (localX - canonicalX)) + ((localY - canonicalY) * (localY - canonicalY))
                : 0;
            if (
                requireClosePosition &&
                Number.isFinite(localX) &&
                Number.isFinite(localY) &&
                distanceSq > EntityHandler.CANONICAL_VISIBLE_PROXY_MATCH_MAX_DISTANCE_SQ
            ) {
                continue;
            }
            if (distanceSq < bestDistanceSq) {
                bestDistanceSq = distanceSq;
                bestLocalId = local;
            }
        }

        return bestLocalId;
    }

    private static buildHpDeltaPayload(entityId: number, delta: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(delta);
        return bb.toBuffer();
    }

    private static sendServerAuthorityProxyInitialHpSync(
        client: Client,
        canonical: any,
        localEntityId: number,
        reason: string
    ): void {
        const localId = Math.max(0, Math.round(Number(localEntityId) || 0));
        const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? 0) || 0));
        const maxHp = Math.max(0, Math.round(Number(canonical?.maxHp ?? 0)));
        const hp = Math.max(0, Math.round(Number(canonical?.hp ?? 0)));
        if (localId <= 0 || canonicalId <= 0 || maxHp <= 0 || hp <= 0) {
            return;
        }

        const damageTaken = Math.max(0, maxHp - hp);
        client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, maxHp));
        if (damageTaken > 0) {
            client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -damageTaken));
        }

        logJcMini1Authority('proxy_initial_hp_sync', {
            packetId: '0x78',
            reason,
            entityId: canonicalId,
            localEntityId: localId,
            name: canonical?.name ?? '',
            viewer: client.character?.name ?? '',
            viewerToken: client.token,
            scope: getClientLevelScope(client),
            entityLevel: canonical?.level,
            hp,
            maxHp,
            positiveDelta: maxHp,
            negativeDelta: damageTaken > 0 ? -damageTaken : 0,
            dead: Boolean(canonical?.dead),
            entState: canonical?.entState
        });
    }

    static ensureServerAuthorityProxyOwner(client: Client, canonicalEntity: any, localEntityId: number): boolean {
        if (!canonicalEntity || typeof canonicalEntity !== 'object') {
            return false;
        }

        const levelScope = getClientLevelScope(client);
        const canonicalId = Math.max(0, Math.round(Number(canonicalEntity.id ?? 0)));
        const localId = Math.max(0, Math.round(Number(localEntityId) || 0));
        const previousOwnerToken = Math.max(0, Math.round(Number(canonicalEntity.proxyOwnerToken ?? 0)));
        const previousOwner = previousOwnerToken > 0 ? GlobalState.sessionsByToken.get(previousOwnerToken) : null;
        const previousOwnerActive = Boolean(
            previousOwner?.playerSpawned &&
            !previousOwner.socket?.destroyed &&
            getClientLevelScope(previousOwner) === levelScope
        );
        const clientPreferred = EntityHandler.isPreferredServerAuthorityProxyOwner(client, levelScope);
        const previousOwnerPreferred = previousOwner
            ? EntityHandler.isPreferredServerAuthorityProxyOwner(previousOwner, levelScope)
            : false;

        if (!previousOwnerActive || (clientPreferred && !previousOwnerPreferred && previousOwnerToken !== client.token)) {
            canonicalEntity.proxyOwnerToken = client.token;
            canonicalEntity.proxyOwnerName = client.character?.name ?? '';
            canonicalEntity.proxyOwnerLocalId = localId;
            logJcMini1Authority(previousOwnerToken > 0 ? 'proxy_owner_migrated' : 'proxy_owner_selected', {
                entityId: canonicalId,
                localEntityId: localId,
                previousOwnerToken,
                ownerToken: client.token,
                owner: client.character?.name ?? '',
                name: canonicalEntity.name,
                scope: levelScope,
                hp: Math.round(Number(canonicalEntity.hp ?? 0)),
                maxHp: Math.round(Number(canonicalEntity.maxHp ?? 0)),
                dead: Boolean(canonicalEntity.dead),
                entState: canonicalEntity.entState
            });
            return true;
        }

        return previousOwnerToken === client.token;
    }

    private static isPreferredServerAuthorityProxyOwner(client: Client, levelScope: string): boolean {
        if (!client?.playerSpawned || getClientLevelScope(client) !== levelScope) {
            return false;
        }

        const instanceOwnerToken = Math.max(0, Math.round(Number(client.levelInstanceId ?? 0) || 0));
        if (instanceOwnerToken > 0 && client.token === instanceOwnerToken) {
            return true;
        }
        if (instanceOwnerToken > 0) {
            const instanceOwner = GlobalState.sessionsByToken.get(instanceOwnerToken);
            if (
                instanceOwner?.playerSpawned &&
                !instanceOwner.socket?.destroyed &&
                getClientLevelScope(instanceOwner) === levelScope
            ) {
                return false;
            }
        }

        let bestSession: Client | null = null;
        let bestStartedAt = Number.POSITIVE_INFINITY;
        for (const session of GlobalState.sessionsByToken.values()) {
            if (
                !session.playerSpawned ||
                session.socket?.destroyed ||
                getClientLevelScope(session) !== levelScope ||
                !areClientsInSameParty(client, session)
            ) {
                continue;
            }

            const startedAt = Math.max(0, Math.round(Number(session.syncAnchorStartedAt ?? 0) || 0));
            const comparableStartedAt = startedAt > 0 ? startedAt : Number.MAX_SAFE_INTEGER;
            if (
                !bestSession ||
                comparableStartedAt < bestStartedAt ||
                (comparableStartedAt === bestStartedAt && session.token < bestSession.token)
            ) {
                bestSession = session;
                bestStartedAt = comparableStartedAt;
            }
        }

        if (bestSession) {
            return bestSession.token === client.token;
        }

        return isClientPartyLeader(client);
    }

    private static syncCanonicalVisibleServerAuthorityHostileFromProxy(
        client: Client,
        canonical: any,
        proxy: any,
        localEntityId: number
    ): void {
        if (!canonical || !proxy || typeof canonical !== 'object' || typeof proxy !== 'object') {
            return;
        }

        const ownerToken = Math.max(0, Math.round(Number(canonical.proxyOwnerToken ?? 0)));
        if (ownerToken > 0 && ownerToken !== client.token) {
            return;
        }

        const preservedHp = canonical.hp;
        const preservedMaxHp = canonical.maxHp;
        const preservedHealthDelta = canonical.healthDelta;
        const preservedHealthDeltaSnake = canonical.health_delta;
        const preservedDead = canonical.dead;
        const preservedUntargetable = canonical.untargetable;

        const fields = [
            'x',
            'y',
            'v',
            'renderDepthOffset',
            'characterName',
            'dramaAnim',
            'sleepAnim',
            'summonerId',
            'powerId',
            'facingLeft',
            'running',
            'jumping',
            'dropping',
            'backpedal',
            'roomId'
        ];
        for (const field of fields) {
            if (proxy[field] !== undefined) {
                canonical[field] = proxy[field];
            }
        }

        canonical.proxyOwnerLocalId = Math.max(0, Math.round(Number(localEntityId) || 0));
        canonical.lastProxyUpdateAt = Date.now();
        canonical.hp = preservedHp;
        canonical.maxHp = preservedMaxHp;
        canonical.healthDelta = preservedHealthDelta;
        canonical.health_delta = preservedHealthDeltaSnake;
        canonical.dead = preservedDead;
        canonical.untargetable = preservedUntargetable;
        canonical.clientSpawned = false;
    }

    private static fanOutCanonicalVisibleServerAuthorityHostile(
        source: Client,
        levelName: string | null | undefined,
        canonical: any
    ): void {
        if (!EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelName)) {
            return;
        }

        const levelScope = getClientLevelScope(source);
        const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? 0)));
        if (!levelScope || canonicalId <= 0) {
            return;
        }

        for (const viewer of GlobalState.sessionsByToken.values()) {
            if (
                viewer === source ||
                !viewer.playerSpawned ||
                viewer.socket?.destroyed ||
                getClientLevelScope(viewer) !== levelScope
            ) {
                continue;
            }

            const localId = EntityHandler.findClientLocalServerAuthorityProxyForCanonical(viewer, levelName, canonical);
            if (localId <= 0) {
                logJcMini1Authority('canonical_visible_bridge_wait_for_proxy', {
                    reason: 'first_sight_owner_canonical_fanout',
                    entityId: Math.max(0, Math.round(Number(canonical?.id ?? 0))),
                    localEntityId: 0,
                    name: canonical?.name ?? '',
                    viewer: viewer.character?.name ?? '',
                    viewerToken: viewer.token,
                    scope: levelScope
                });
                continue;
            }

            EntityHandler.bridgeCanonicalVisibleServerAuthorityProxy(
                viewer,
                levelName,
                canonical,
                viewer.entities.get(localId),
                localId,
                Boolean(canonical.dead) || Number(canonical.entState ?? EntityState.ACTIVE) === EntityState.DEAD,
                'first_sight_owner_canonical_fanout'
            );
        }
    }

    static isServerAuthorityProxyOwner(client: Client, canonicalEntity: any, localEntityId: number): boolean {
        if (!EntityHandler.isServerAuthorityHostileEntity(client.currentLevel, canonicalEntity)) {
            return false;
        }

        return EntityHandler.ensureServerAuthorityProxyOwner(client, canonicalEntity, localEntityId);
    }

    private static sendTombstoneDeathCorrectionOnRejoin(
        client: Client,
        entity: any,
        rawLocalId: number,
        tombstone: DeadHostileTombstone
    ): void {
        const localId = Math.max(0, Math.round(Number(rawLocalId || entity?.id) || 0));
        if (localId <= 0) {
            return;
        }

        const scope = getClientLevelScope(client);
        const maxHp = Math.max(
            1,
            Math.round(Number(entity?.maxHp ?? 0)) ||
                EntityHandler.estimateServerAuthorityHostileMaxHp(entity) ||
                1
        );
        client.entities.set(localId, {
            ...entity,
            id: localId,
            hp: 0,
            maxHp,
            healthDelta: -maxHp,
            health_delta: -maxHp,
            dead: true,
            destroyed: true,
            entState: EntityState.DEAD,
            canonicalEntityId: tombstone.canonicalId,
            sharedCanonicalId: tombstone.canonicalId
        });
        client.knownEntityIds.add(localId);
        if (tombstone.canonicalId > 0) {
            client.knownEntityIds.add(tombstone.canonicalId);
        }
        client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -maxHp));
        client.send(0x07, EntityHandler.buildEntityStateDeadPayload(localId));
        client.send(0x0D, EntityHandler.buildDestroyEntityPayload(localId));
        client.entities.delete(localId);
        client.knownEntityIds.delete(localId);

        console.log(
            `[MultiplayerSync][rejoin-dead-hostile-suppressed] viewer=${String(client.character?.name ?? '')} token=${client.token} scope=${scope} rawLocalId=${localId} canonicalId=${tombstone.canonicalId} spawnKey=${tombstone.spawnKey}`
        );
        console.log(
            `[MultiplayerSync][death-correction-on-rejoin] viewer=${String(client.character?.name ?? '')} token=${client.token} localId=${localId} canonicalId=${tombstone.canonicalId} spawnKey=${tombstone.spawnKey}`
        );
        console.log(
            `[LootSync][rejoin-dead-hostile-no-loot] viewer=${String(client.character?.name ?? '')} token=${client.token} canonicalId=${tombstone.canonicalId} spawnKey=${tombstone.spawnKey} reason=tombstone_exists`
        );
    }

    private static attachServerAuthorityClientHostileProxy(
        client: Client,
        levelName: string | null | undefined,
        levelMap: Map<number, any> | null,
        entity: any,
        rawEntityId: number
    ): boolean {
        if (
            !EntityHandler.usesServerAuthorityHostiles(levelName) ||
            !entity ||
            entity.isPlayer ||
            Number(entity.team ?? 0) !== EntityTeam.ENEMY
        ) {
            return false;
        }

        const levelScope = getClientLevelScope(client);
        entity.spawnKey = entity.spawnKey || EntityHandler.getHostileSpawnKey(levelScope, entity);
        const tombstone = EntityHandler.findDeadServerAuthorityHostileTombstone(levelScope, entity);
        if (tombstone) {
            const localId = Math.max(0, Math.round(Number(rawEntityId || entity.id) || 0));
            if (localId > 0 && tombstone.canonicalId > 0 && localId !== tombstone.canonicalId) {
                EntityHandler.rememberEntityAlias(client, localId, tombstone.canonicalId);
            }
            console.log(
                `[MultiplayerSync][spawnkey-match] scope=${levelScope} rawLocalId=${localId} canonicalId=${tombstone.canonicalId} spawnKey=${tombstone.spawnKey} result=tombstone`
            );
            EntityHandler.sendTombstoneDeathCorrectionOnRejoin(client, entity, localId, tombstone);
            return true;
        }

        if (EntityHandler.isDestroyedServerAuthorityHostileProxy(client, entity)) {
            EntityHandler.destroyDeadServerAuthorityLocalProxy(client, entity, rawEntityId);
            return true;
        }

        const existingCanonical = EntityHandler.findServerAuthorityProxyCanonical(levelName, levelMap, entity);
        const canonical = existingCanonical ??
            EntityHandler.promoteFirstSightServerAuthorityHostile(client, levelName, levelMap, entity, rawEntityId);
        if (!canonical) {
            console.log(
                `[MultiplayerSync][spawnkey-match] scope=${levelScope} rawLocalId=${Math.max(0, Math.round(Number(rawEntityId || entity.id) || 0))} canonicalId=0 spawnKey=${String(entity.spawnKey ?? '')} result=miss`
            );
            return false;
        }

        EntityHandler.normalizeServerAuthorityHostileState(levelName, canonical);
        const canonicalId = Math.max(0, Math.round(Number(canonical.id ?? 0)));
        const localId = Math.max(0, Math.round(Number(rawEntityId || entity.id) || 0));
        if (canonicalId <= 0 || localId <= 0) {
            return false;
        }
        console.log(
            `[MultiplayerSync][spawnkey-match] scope=${levelScope} rawLocalId=${localId} canonicalId=${canonicalId} spawnKey=${String(entity.spawnKey ?? EntityHandler.getHostileSpawnKey(levelScope, entity))} result=active`
        );

        const existingLocalId = EntityHandler.findExistingServerAuthorityProxyLocalId(client, canonicalId, localId);
        if (existingLocalId > 0) {
            EntityHandler.destroyClientLocalEntity(client, localId, 'proxy_duplicate_destroy', entity);
            logJcMini1Authority('proxy_duplicate_destroy', {
                entityId: canonicalId,
                localEntityId: localId,
                existingLocalEntityId: existingLocalId,
                name: canonical.name,
                viewer: client.character?.name ?? '',
                viewerToken: client.token,
                scope: getClientLevelScope(client),
                hp: Math.round(Number(canonical.hp ?? 0)),
                maxHp: Math.round(Number(canonical.maxHp ?? 0)),
                dead: Boolean(canonical.dead),
                entState: canonical.entState
            });
            return true;
        }

        const isDead = Boolean(canonical.dead) || Number(canonical.entState ?? EntityState.ACTIVE) === EntityState.DEAD;
        EntityHandler.ensureServerAuthorityProxyOwner(client, canonical, localId);
        EntityHandler.registerCanonicalHostileAlias(
            client,
            getClientLevelScope(client),
            canonical,
            localId,
            localId === canonicalId ? 'server_authority_same_id_attach' : 'server_authority_proxy_attach'
        );
        if (!EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelName)) {
            if (localId !== canonicalId) {
                EntityHandler.rememberEntityAlias(client, localId, canonicalId);
            }
            client.knownEntityIds.add(canonicalId);
            client.knownEntityIds.add(localId);

            const proxyEntity = {
                ...entity,
                id: localId,
                level: EntityHandler.SERVER_AUTHORITY_ENTITY_LEVEL,
                hp: Math.max(0, Math.round(Number(canonical.hp ?? 0))),
                maxHp: Math.max(0, Math.round(Number(canonical.maxHp ?? 0))),
                healthDelta: Math.round(Number(canonical.healthDelta ?? 0)),
                health_delta: Math.round(Number(canonical.health_delta ?? canonical.healthDelta ?? 0)),
                dead: isDead,
                entState: isDead ? EntityState.DEAD : Number(entity.entState ?? canonical.entState ?? EntityState.ACTIVE),
                canonicalEntityId: canonicalId,
                sharedCanonicalId: canonicalId,
                clientSpawned: true,
                ownerToken: client.token,
                ownerUserId: client.userId ?? 0,
                ownerCharacterName: client.character?.name ?? '',
                ownerPartyId: getPartyIdForClient(client)
            };
            client.entities.set(localId, proxyEntity);

            logJcMini1Authority('proxy_attach', {
                entityId: canonicalId,
                localEntityId: localId,
                rawEntityId,
                name: canonical.name,
                proxyName: entity.name,
                viewer: client.character?.name ?? '',
                viewerToken: client.token,
                ownerToken: canonical.proxyOwnerToken ?? 0,
                scope: getClientLevelScope(client),
                roomId: canonical.roomId,
                viewerRoomId: client.currentRoomId,
                entityLevel: canonical.level,
                hp: Math.round(Number(canonical.hp ?? 0)),
                maxHp: Math.round(Number(canonical.maxHp ?? 0)),
                dead: isDead,
                entState: canonical.entState
            });

            if (isDead) {
                const maxHp = Math.max(0, Math.round(Number(canonical.maxHp ?? 0)));
                if (maxHp > 0) {
                    client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -maxHp));
                    logJcMini1Authority('authoritative_hp_correction', {
                        packetId: '0x78',
                        reason: 'late_proxy_dead_canonical',
                        entityId: canonicalId,
                        localEntityId: localId,
                        viewer: client.character?.name ?? '',
                        viewerToken: client.token,
                        scope: getClientLevelScope(client),
                        previousHp: maxHp,
                        expectedDamage: 0,
                        expectedPostPacketHp: maxHp,
                        canonicalHp: 0,
                        maxHp,
                        delta: -maxHp,
                        dead: true,
                        entState: EntityState.DEAD
                    });
                }
                client.send(0x07, EntityHandler.buildEntityStateDeadPayload(localId));
                client.send(0x0D, EntityHandler.buildDestroyEntityPayload(localId));
                client.entities.delete(localId);
                logJcMini1Authority('canonical_state_to_proxy', {
                    packetId: maxHp > 0 ? '0x78+0x07+0x0D' : '0x07+0x0D',
                    reason: 'late_proxy_dead_canonical',
                    entityId: canonicalId,
                    localEntityId: localId,
                    viewer: client.character?.name ?? '',
                    viewerToken: client.token,
                    scope: getClientLevelScope(client),
                    hp: 0,
                    maxHp,
                    dead: true,
                    entState: EntityState.DEAD
                });
            } else {
                EntityHandler.sendServerAuthorityProxyInitialHpSync(client, canonical, localId, 'proxy_attach');
            }

            return true;
        }
        if (EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelName)) {
            EntityHandler.bridgeCanonicalVisibleServerAuthorityProxy(
                client,
                levelName,
                canonical,
                entity,
                localId,
                isDead,
                isDead ? 'proxy_bridge_attach_dead' : 'proxy_bridge_attach_live'
            );

            logJcMini1Authority('proxy_attach', {
                entityId: canonicalId,
                localEntityId: localId,
                rawEntityId,
                name: canonical.name,
                proxyName: entity.name,
                viewer: client.character?.name ?? '',
                viewerToken: client.token,
                ownerToken: canonical.proxyOwnerToken ?? 0,
                scope: getClientLevelScope(client),
                roomId: canonical.roomId,
                viewerRoomId: client.currentRoomId,
                entityLevel: canonical.level,
                hp: Math.round(Number(canonical.hp ?? 0)),
                maxHp: Math.round(Number(canonical.maxHp ?? 0)),
                dead: isDead,
                entState: canonical.entState,
                bridge: true
            });
            return true;
        }
        EntityHandler.replaceClientHostileProxyWithCanonical(
            client,
            levelName,
            canonical,
            localId,
            isDead ? 'proxy_attach_dead' : 'proxy_attach_live',
            entity
        );

        logJcMini1Authority('proxy_attach', {
            entityId: canonicalId,
            localEntityId: localId,
            rawEntityId,
            name: canonical.name,
            proxyName: entity.name,
            viewer: client.character?.name ?? '',
            viewerToken: client.token,
            ownerToken: canonical.proxyOwnerToken ?? 0,
            scope: getClientLevelScope(client),
            roomId: canonical.roomId,
            viewerRoomId: client.currentRoomId,
            entityLevel: canonical.level,
            hp: Math.round(Number(canonical.hp ?? 0)),
            maxHp: Math.round(Number(canonical.maxHp ?? 0)),
            dead: isDead,
            entState: canonical.entState
        });

        if (isDead) {
            const maxHp = Math.max(0, Math.round(Number(canonical.maxHp ?? 0)));
            if (maxHp > 0) {
                client.send(0x78, EntityHandler.buildHpDeltaPayload(canonicalId, -maxHp));
                logJcMini1Authority('authoritative_hp_correction', {
                    packetId: '0x78',
                    reason: 'late_proxy_dead_canonical',
                    entityId: canonicalId,
                    localEntityId: canonicalId,
                    viewer: client.character?.name ?? '',
                    viewerToken: client.token,
                    scope: getClientLevelScope(client),
                    previousHp: maxHp,
                    expectedDamage: 0,
                    expectedPostPacketHp: maxHp,
                    canonicalHp: 0,
                    maxHp,
                    delta: -maxHp,
                    dead: true,
                    entState: EntityState.DEAD
                });
            }
            client.send(0x07, EntityHandler.buildEntityStateDeadPayload(canonicalId));
            client.send(0x0D, EntityHandler.buildDestroyEntityPayload(canonicalId));
            client.entities.delete(canonicalId);
            client.knownEntityIds.delete(canonicalId);
            logJcMini1Authority('canonical_state_to_proxy', {
                packetId: maxHp > 0 ? '0x78+0x07+0x0D' : '0x07+0x0D',
                reason: 'late_proxy_dead_canonical',
                entityId: canonicalId,
                localEntityId: canonicalId,
                viewer: client.character?.name ?? '',
                viewerToken: client.token,
                scope: getClientLevelScope(client),
                hp: 0,
                maxHp,
                dead: true,
                entState: EntityState.DEAD
            });
        }

        return true;
    }

    private static replaceClientHostileProxyWithCanonical(
        client: Client,
        levelName: string | null | undefined,
        canonical: any,
        rawLocalEntityId: number,
        reason: string,
        rawLocalEntity: any = null
    ): void {
        if (!EntityHandler.isServerAuthorityHostileEntity(levelName, canonical)) {
            return;
        }

        EntityHandler.normalizeServerAuthorityHostileState(levelName, canonical);
        const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? 0)));
        const localId = Math.max(0, Math.round(Number(rawLocalEntityId) || 0));
        if (canonicalId <= 0) {
            return;
        }

        const existingCanonical = client.entities.get(canonicalId);
        const hasServerCanonical =
            Boolean(existingCanonical) &&
            !Boolean(existingCanonical?.clientSpawned) &&
            client.knownEntityIds.has(canonicalId);

        if (localId > 0 && (localId !== canonicalId || !hasServerCanonical)) {
            EntityHandler.destroyClientLocalEntity(client, localId, reason, rawLocalEntity);
        }
        if (localId > 0 && localId !== canonicalId) {
            EntityHandler.rememberEntityAlias(client, localId, canonicalId);
        }

        const snapshot = {
            ...canonical,
            id: canonicalId,
            clientSpawned: false,
            canonicalEntityId: undefined,
            sharedCanonicalId: undefined,
            ownerToken: 0,
            ownerUserId: 0,
            ownerPartyId: 0,
            ownerCharacterName: ''
        };
        client.entities.delete(localId);
        client.knownEntityIds.delete(localId);
        client.entities.set(canonicalId, { ...snapshot });
        client.knownEntityIds.add(canonicalId);
        EntityHandler.setSharedEntityRemoteUpdatesDeferred(client, canonicalId, false);
        const needsCanonicalSpawn = !hasServerCanonical || localId === canonicalId;
        if (needsCanonicalSpawn) {
            EntityHandler.sendEntity(client, snapshot);
            if (Boolean(snapshot.untargetable)) {
                EntityHandler.sendSetUntargetable(client, canonicalId, true);
            }
        }

        logJcMini1Authority('canonical_spawn_replace_proxy', {
            packetId: localId > 0 && (localId !== canonicalId || !hasServerCanonical)
                ? (needsCanonicalSpawn ? '0x0D+0x0F' : '0x0D')
                : '0x0F',
            reason,
            entityId: canonicalId,
            localEntityId: localId,
            name: snapshot.name,
            viewer: client.character?.name ?? '',
            viewerToken: client.token,
            scope: getClientLevelScope(client),
            hp: Math.round(Number(snapshot.hp ?? 0)),
            maxHp: Math.round(Number(snapshot.maxHp ?? 0)),
            healthDelta: Math.round(Number(snapshot.healthDelta ?? 0)),
            dead: Boolean(snapshot.dead),
            entState: snapshot.entState,
            untargetable: Boolean(snapshot.untargetable),
            canonicalSpawnSent: needsCanonicalSpawn
        });
    }

    private static bridgeCanonicalVisibleServerAuthorityProxy(
        client: Client,
        levelName: string | null | undefined,
        canonical: any,
        rawLocalEntity: any,
        rawLocalEntityId: number,
        isDead: boolean,
        reason: string
    ): void {
        if (!EntityHandler.isServerAuthorityHostileEntity(levelName, canonical)) {
            return;
        }

        EntityHandler.normalizeServerAuthorityHostileState(levelName, canonical);
        const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? 0)));
        const localId = Math.max(0, Math.round(Number(rawLocalEntityId) || 0));
        if (canonicalId <= 0 || localId <= 0) {
            return;
        }

        const localEntity = rawLocalEntity && typeof rawLocalEntity === 'object'
            ? rawLocalEntity
            : client.entities.get(localId) ?? canonical;
        if (localId !== canonicalId) {
            EntityHandler.rememberEntityAlias(client, localId, canonicalId);
        }
        client.knownEntityIds.add(localId);
        client.knownEntityIds.add(canonicalId);
        EntityHandler.setSharedEntityRemoteUpdatesDeferred(client, canonicalId, false);
        EntityHandler.syncCanonicalVisibleServerAuthorityHostileFromProxy(client, canonical, localEntity, localId);

        const maxHp = Math.max(0, Math.round(Number(canonical.maxHp ?? 0)));
        const hp = Math.max(0, Math.round(Number(canonical.hp ?? 0)));
        const healthDelta = hp - maxHp;
        const bridgedEntity = {
            ...localEntity,
            id: localId,
            level: EntityHandler.SERVER_AUTHORITY_ENTITY_LEVEL,
            hp,
            maxHp,
            healthDelta,
            health_delta: healthDelta,
            dead: isDead,
            entState: isDead ? EntityState.DEAD : Number(localEntity?.entState ?? canonical.entState ?? EntityState.ACTIVE),
            canonicalEntityId: canonicalId,
            sharedCanonicalId: canonicalId,
            clientSpawned: true,
            ownerToken: client.token,
            ownerUserId: client.userId ?? 0,
            ownerCharacterName: client.character?.name ?? '',
            ownerPartyId: getPartyIdForClient(client)
        };
        client.entities.set(localId, bridgedEntity);

        if (isDead) {
            if (maxHp > 0) {
                client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -maxHp));
            }
            client.send(0x07, EntityHandler.buildEntityStateDeadPayload(localId));
            client.send(0x0D, EntityHandler.buildDestroyEntityPayload(localId));
            client.entities.delete(localId);
            client.knownEntityIds.delete(localId);
            logJcMini1Authority('canonical_visible_proxy_dead_cleanup', {
                packetId: maxHp > 0 ? '0x78+0x07+0x0D' : '0x07+0x0D',
                reason,
                entityId: canonicalId,
                localEntityId: localId,
                name: canonical.name,
                viewer: client.character?.name ?? '',
                viewerToken: client.token,
                scope: getClientLevelScope(client),
                hp: 0,
                maxHp,
                dead: true,
                entState: EntityState.DEAD
            });
            return;
        }

        EntityHandler.sendServerAuthorityProxyInitialHpSync(client, canonical, localId, reason);
        if (Boolean(canonical.untargetable)) {
            EntityHandler.sendSetUntargetable(client, localId, true);
        }

        logJcMini1Authority('canonical_visible_proxy_bridge', {
            packetId: '0x78',
            reason,
            entityId: canonicalId,
            localEntityId: localId,
            name: canonical.name,
            proxyName: localEntity?.name ?? '',
            viewer: client.character?.name ?? '',
            viewerToken: client.token,
            scope: getClientLevelScope(client),
            hp,
            maxHp,
            dead: false,
            entState: bridgedEntity.entState,
            untargetable: Boolean(canonical.untargetable)
        });
    }

    private static isDestroyedServerAuthorityHostileProxy(client: Client, entity: any): boolean {
        const levelScope = getClientLevelScope(client);
        if (!levelScope) {
            return false;
        }

        const fingerprint = EntityHandler.getServerAuthorityHostileFingerprint(entity);
        return Boolean(
            fingerprint &&
            EntityHandler.serverAuthorityDestroyedFingerprintsByScope.get(levelScope)?.has(fingerprint)
        );
    }

    private static destroyDeadServerAuthorityLocalProxy(client: Client, entity: any, rawEntityId: number): void {
        const localId = Math.max(0, Math.round(Number(rawEntityId || entity?.id) || 0));
        if (localId <= 0) {
            return;
        }

        const deadSnapshot = {
            ...entity,
            id: localId,
            clientSpawned: true,
            ownerToken: client.token,
            ownerUserId: client.userId ?? 0,
            ownerCharacterName: client.character?.name ?? '',
            ownerPartyId: getPartyIdForClient(client),
            dead: true,
            entState: EntityState.DEAD
        };
        EntityHandler.normalizeServerAuthorityHostileState(client.currentLevel, deadSnapshot);
        const maxHp = Math.max(0, Math.round(Number(deadSnapshot.maxHp ?? deadSnapshot.hp ?? 0)));
        client.entities.set(localId, deadSnapshot);
        client.knownEntityIds.add(localId);
        if (maxHp > 0) {
            client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -maxHp));
        }
        client.send(0x07, EntityHandler.buildEntityStateDeadPayload(localId));
        client.send(0x0D, EntityHandler.buildDestroyEntityPayload(localId));
        client.entities.delete(localId);
        client.knownEntityIds.delete(localId);

        logJcMini1Authority('dead_fingerprint_proxy_destroy', {
            entityId: localId,
            rawEntityId: localId,
            name: entity?.name ?? entity?.EntName ?? '',
            viewer: client.character?.name ?? '',
            viewerToken: client.token,
            scope: getClientLevelScope(client),
            roomId: entity?.roomId,
            x: Math.round(Number(entity?.x ?? 0)),
            y: Math.round(Number(entity?.y ?? 0)),
            maxHp,
            dead: true,
            entState: EntityState.DEAD
        });
    }

    private static promoteFirstSightServerAuthorityHostile(
        client: Client,
        levelName: string | null | undefined,
        levelMap: Map<number, any> | null,
        entity: any,
        rawEntityId: number
    ): any | null {
        const normalizedLevelName = LevelConfig.normalizeLevelName(levelName);
        if (
            !normalizedLevelName ||
            !EntityHandler.FIRST_SIGHT_SERVER_AUTHORITY_HOSTILE_LEVELS.has(normalizedLevelName) ||
            !levelMap ||
            !entity ||
            entity.isPlayer ||
            Number(entity.team ?? 0) !== EntityTeam.ENEMY
        ) {
            return null;
        }

        const canonicalId = Math.max(0, Math.round(Number(rawEntityId || entity.id) || 0));
        if (canonicalId <= 0) {
            return null;
        }

        const existing = levelMap.get(canonicalId);
        if (existing && !existing.isPlayer) {
            return existing;
        }

        const canonical = {
            ...entity,
            id: canonicalId,
            clientSpawned: false,
            ownerToken: 0,
            ownerUserId: 0,
            ownerPartyId: 0,
            ownerCharacterName: '',
            canonicalEntityId: undefined,
            sharedCanonicalId: undefined,
            proxyOwnerToken: client.token,
            proxyOwnerName: client.character?.name ?? '',
            proxyOwnerLocalId: canonicalId
        };
        EntityHandler.normalizeServerAuthorityHostileState(normalizedLevelName, canonical);
        levelMap.set(canonicalId, canonical);
        console.log(
            `[MultiplayerSync][first-sight-authority] scope=${getClientLevelScope(client)} source=${String(client.character?.name ?? '')} sourceToken=${client.token} entityId=${canonicalId} name=${String(canonical.name ?? '')} hp=${Math.round(Number(canonical.hp ?? 0))} maxHp=${Math.round(Number(canonical.maxHp ?? 0))}`
        );
        EntityHandler.fanOutCanonicalVisibleServerAuthorityHostile(client, normalizedLevelName, canonical);
        return canonical;
    }

    private static resetServerAuthorityScopeForFreshRun(client: Client, levelName: string, levelMap: Map<number, any>): void {
        if (!EntityHandler.usesServerAuthorityHostiles(levelName)) {
            return;
        }

        const levelScope = getLevelScopeKey(levelName, client.levelInstanceId);
        if (!levelScope || EntityHandler.hasOtherActiveSessionInScope(client, levelScope)) {
            return;
        }

        if (
            String(client.levelInstanceId ?? '').trim() &&
            Array.from(levelMap.values()).some((entity) => EntityHandler.isServerAuthorityHostileEntity(levelName, entity))
        ) {
            return;
        }

        if (EntityHandler.clientKnowsServerAuthorityHostile(client, levelMap)) {
            return;
        }

        let removed = 0;
        for (const [entityId, entity] of Array.from(levelMap.entries())) {
            if (!entity?.isPlayer && Number(entity?.team ?? 0) === EntityTeam.ENEMY) {
                levelMap.delete(entityId);
                removed++;
            }
        }

        EntityHandler.serverAuthoritySeededScopes.delete(levelScope);
        EntityHandler.serverAuthorityDestroyedIdsByScope.delete(levelScope);
        EntityHandler.serverAuthorityDestroyedFingerprintsByScope.delete(levelScope);
        EntityHandler.clearDeadServerAuthorityHostileTombstones(levelScope, 'new_run');
        GlobalState.levelQuestProgress.delete(levelScope);
        const keyPrefix = `${levelScope}:`;
        for (const key of Array.from(GlobalState.combatContributions.keys())) {
            if (key.startsWith(keyPrefix)) {
                GlobalState.combatContributions.delete(key);
            }
        }
        for (const key of Array.from(GlobalState.entityLifeNonces.keys())) {
            if (key.startsWith(keyPrefix)) {
                GlobalState.entityLifeNonces.delete(key);
            }
        }
        for (const key of Array.from(GlobalState.entityLastRewardNonces.keys())) {
            if (key.startsWith(keyPrefix)) {
                GlobalState.entityLastRewardNonces.delete(key);
            }
        }

        logJcMini1Authority('fresh_scope_reset', {
            scope: levelScope,
            viewer: client.character?.name ?? '',
            viewerToken: client.token,
            removed
        });
    }

    static suppressServerAuthorityClientHostileSpawn(
        client: Client,
        levelName: string | null | undefined,
        entity: any,
        rawEntityId: number,
        reason: string = 'client_hostile_spawn'
    ): boolean {
        if (levelName) {
            EntityHandler.ensureJcMini1PartySharedScope(client, levelName, reason);
        }
        const levelMap = levelName ? EntityHandler.getLevelMapForClient(client, true) : null;
        if (levelName && levelMap && EntityHandler.usesServerAuthorityHostiles(levelName)) {
            EntityHandler.seedServerAuthorityHostiles(client, levelName, levelMap);
        }
        return EntityHandler.attachServerAuthorityClientHostileProxy(client, levelName, levelMap, entity, rawEntityId);
    }

    static destroyClientLocalEntity(
        client: Client,
        rawEntityId: number,
        reason: string,
        entity: any = null
    ): void {
        const localId = Math.max(0, Math.round(Number(rawEntityId) || 0));
        if (localId <= 0) {
            return;
        }

        client.entities.delete(localId);
        client.knownEntityIds.delete(localId);
        client.entityIdAliases?.delete(localId);
        client.send(0x0D, EntityHandler.buildDestroyEntityPayload(localId));
        logJcMini1Authority('client_local_hostile_destroy', {
            reason,
            rawEntityId: localId,
            name: entity?.name ?? entity?.EntName ?? '',
            team: entity?.team ?? '',
            scope: getClientLevelScope(client),
            viewer: client.character?.name ?? '',
            viewerToken: client.token,
            viewerRoomId: client.currentRoomId,
            knownEntityIds: Array.from(client.knownEntityIds ?? []).slice(0, 80)
        });
    }

    private static usesLeaderAuthoritativeClientSpawns(levelName: string | null | undefined): boolean {
        // Hybrid dungeon authority: while Flash still runs temporary enemy AI,
        // server-owned DungeonInstance state chooses one canonical client-spawn
        // actor and aliases follower duplicates to it. TODO: replace this bridge
        // with full server-side enemy spawning and AI.
        return LevelConfig.isDungeonLevel(levelName);
    }

    private static shouldSkipDungeonRoomProgressSync(levelName: string | null | undefined): boolean {
        return Boolean(levelName) && EntityHandler.GOBLIN_RIVER_ROOM_SYNC_SKIP_LEVELS.has(String(levelName));
    }

    private static isEntityDead(entity: any): boolean {
        return Boolean(entity?.dead) ||
            Boolean(entity?.destroyed) ||
            Number(entity?.entState ?? EntityState.ACTIVE) === EntityState.DEAD ||
            Math.round(Number(entity?.hp ?? 1)) <= 0;
    }

    private static formatMultiplayerAliasDetails(details: Record<string, unknown>): string {
        return Object.entries(details)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(' ');
    }

    private static logMultiplayerAlias(label: string, details: Record<string, unknown>): void {
        console.log(`[MultiplayerSync][${label}] ${EntityHandler.formatMultiplayerAliasDetails(details)}`);
    }

    private static getHostileAliasMap(entity: any): Map<number, number> {
        if (!entity || typeof entity !== 'object') {
            return new Map<number, number>();
        }

        if (entity.localIdsByToken instanceof Map) {
            return entity.localIdsByToken;
        }

        const map = new Map<number, number>();
        const raw = entity.localIdsByToken;
        if (raw && typeof raw === 'object') {
            for (const [tokenValue, localIdValue] of Object.entries(raw)) {
                const token = Math.max(0, Math.round(Number(tokenValue) || 0));
                const localId = Math.max(0, Math.round(Number(localIdValue) || 0));
                if (token > 0 && localId > 0) {
                    map.set(token, localId);
                }
            }
        }
        entity.localIdsByToken = map;
        return map;
    }

    static getHostileSpawnKey(levelScope: string, entity: any): string {
        const roomId = Number.isFinite(Number(entity?.roomId)) ? Math.round(Number(entity.roomId)) : -1;
        const entName = EntityHandler.normalizeIdentityName(
            entity?.entType ??
            entity?.EntType ??
            entity?.name ??
            entity?.EntName ??
            entity?.characterName ??
            entity?.character_name
        );
        const spawnIndex = Math.max(
            -1,
            Math.round(Number(
                entity?.spawnIndex ??
                entity?.spawn_index ??
                entity?.spawnId ??
                entity?.spawn_id ??
                entity?.SpawnIndex ??
                -1
            ) || -1)
        );
        const rawX = Number(entity?.x ?? entity?.physPosX ?? 0);
        const rawY = Number(entity?.y ?? entity?.physPosY ?? 0);
        const bucketX = Number.isFinite(rawX) ? Math.round(rawX / 25) * 25 : 0;
        const bucketY = Number.isFinite(rawY) ? Math.round(rawY / 25) * 25 : 0;
        return [
            levelScope,
            `room:${roomId}`,
            `type:${entName}`,
            spawnIndex >= 0 ? `spawn:${spawnIndex}` : `pos:${bucketX}:${bucketY}`
        ].join('|');
    }

    private static normalizeCanonicalHostileAliasRegistry(
        levelScope: string,
        canonical: any,
        canonicalId: number,
        localId: number,
        client: Client
    ): void {
        if (!canonical || typeof canonical !== 'object' || canonicalId <= 0 || localId <= 0) {
            return;
        }

        canonical.canonicalId = canonicalId;
        canonical.levelScope = levelScope;
        canonical.spawnKey = canonical.spawnKey || EntityHandler.getHostileSpawnKey(levelScope, canonical);
        canonical.entType = canonical.entType ?? canonical.EntType ?? canonical.name ?? canonical.EntName ?? '';
        canonical.ownerToken = Math.max(0, Math.round(Number(canonical.ownerToken ?? client.token ?? 0)));
        canonical.aiOwnerToken = Math.max(0, Math.round(Number(canonical.aiOwnerToken ?? canonical.ownerToken ?? client.token ?? 0)));
        canonical.ownerPartyId = Math.max(0, Math.round(Number(canonical.ownerPartyId ?? getPartyIdForClient(client) ?? 0)));
        if (!Number.isFinite(Number(canonical.roomId))) {
            canonical.roomId = client.currentRoomId;
        }
        EntityHandler.getHostileAliasMap(canonical).set(client.token, localId);
    }

    static registerCanonicalHostileAlias(
        client: Client,
        levelScope: string,
        canonical: any,
        localEntityId: number,
        reason: string
    ): void {
        const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? canonical?.canonicalId ?? 0)));
        const localId = Math.max(0, Math.round(Number(localEntityId) || 0));
        if (!levelScope || !canonical || canonicalId <= 0 || localId <= 0) {
            return;
        }

        EntityHandler.normalizeCanonicalHostileAliasRegistry(levelScope, canonical, canonicalId, localId, client);
        if (localId !== canonicalId) {
            EntityHandler.rememberEntityAlias(client, localId, canonicalId);
        }
        client.knownEntityIds.add(localId);
        client.knownEntityIds.add(canonicalId);
        EntityHandler.logMultiplayerAlias('alias-register', {
            scope: levelScope,
            viewer: client.character?.name ?? '',
            token: client.token,
            localId,
            canonicalId,
            reason
        });
        EntityHandler.dumpHostileAliasTable(levelScope);
    }

    static resolveHostileLocalIdForViewer(
        viewer: Client,
        levelScope: string,
        canonicalId: number,
        packetLabel: string = ''
    ): { ok: boolean; localId: number; entity: any | null; reason: string } {
        const entityId = Math.max(0, Math.round(Number(canonicalId) || 0));
        if (!levelScope || entityId <= 0) {
            return { ok: true, localId: entityId, entity: null, reason: 'invalid_or_noncanonical' };
        }

        const canonical = GlobalState.levelEntities.get(levelScope)?.get(entityId) ?? null;
        if (
            !canonical ||
            Boolean(canonical.isPlayer) ||
            Number(canonical.team ?? 0) !== EntityTeam.ENEMY ||
            (
                !EntityHandler.isSharedClientSpawnRegionActor(getScopeLevelName(levelScope), canonical) &&
                !EntityHandler.isServerAuthorityHostileEntity(getScopeLevelName(levelScope), canonical)
            )
        ) {
            return { ok: true, localId: EntityHandler.resolveEntityLocalId(viewer, entityId), entity: canonical, reason: 'not_hostile_canonical' };
        }

        const aliasMap = EntityHandler.getHostileAliasMap(canonical);
        const registeredLocalId = Math.max(0, Math.round(Number(aliasMap.get(viewer.token)) || 0));
        if (registeredLocalId > 0) {
            if (registeredLocalId !== entityId || viewer.entities.has(registeredLocalId) || viewer.knownEntityIds.has(registeredLocalId)) {
                return { ok: true, localId: registeredLocalId, entity: canonical, reason: 'registered' };
            }
        }

        const legacyLocalId = EntityHandler.resolveEntityLocalId(viewer, entityId);
        if (
            legacyLocalId > 0 &&
            legacyLocalId !== entityId &&
            (viewer.entities.has(legacyLocalId) || viewer.knownEntityIds.has(legacyLocalId))
        ) {
            EntityHandler.registerCanonicalHostileAlias(viewer, levelScope, canonical, legacyLocalId, 'legacy_alias_backfill');
            return { ok: true, localId: legacyLocalId, entity: canonical, reason: 'legacy_alias_backfill' };
        }

        const ownsCanonical = Math.max(0, Math.round(Number(canonical.ownerToken ?? canonical.aiOwnerToken ?? 0))) === viewer.token ||
            Math.max(0, Math.round(Number(canonical.aiOwnerToken ?? canonical.ownerToken ?? 0))) === viewer.token;
        if (
            ownsCanonical &&
            (viewer.entities.has(entityId) || viewer.knownEntityIds.has(entityId) || registeredLocalId === entityId)
        ) {
            EntityHandler.registerCanonicalHostileAlias(viewer, levelScope, canonical, entityId, 'owner_canonical_visible');
            return { ok: true, localId: entityId, entity: canonical, reason: 'owner_canonical_visible' };
        }

        EntityHandler.logMultiplayerAlias('alias-miss-outbound', {
            packet: packetLabel,
            viewer: viewer.character?.name ?? '',
            token: viewer.token,
            canonicalId: entityId,
            reason: 'missing_viewer_local_id'
        });
        return { ok: false, localId: 0, entity: canonical, reason: 'missing_viewer_local_id' };
    }

    static getRegisteredHostileLocalIdForViewer(viewer: Client, canonical: any): number {
        if (!canonical || typeof canonical !== 'object') {
            return 0;
        }
        const aliasMap = EntityHandler.getHostileAliasMap(canonical);
        return Math.max(0, Math.round(Number(aliasMap.get(viewer.token)) || 0));
    }

    static logAliasOutbound(packetLabel: string, viewer: Client, canonicalId: number, localId: number): void {
        EntityHandler.logMultiplayerAlias('alias-out', {
            packet: packetLabel,
            viewer: viewer.character?.name ?? '',
            token: viewer.token,
            canonicalId,
            localId
        });
    }

    static dumpHostileAliasTable(levelScope: string): void {
        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (!levelMap) {
            return;
        }

        const rows: string[] = [];
        for (const [id, entity] of levelMap.entries()) {
            if (
                !entity ||
                Boolean(entity.isPlayer) ||
                Number(entity.team ?? 0) !== EntityTeam.ENEMY ||
                (
                    !EntityHandler.isSharedClientSpawnRegionActor(getScopeLevelName(levelScope), entity) &&
                    !EntityHandler.isServerAuthorityHostileEntity(getScopeLevelName(levelScope), entity)
                )
            ) {
                continue;
            }
            const aliasMap = EntityHandler.getHostileAliasMap(entity);
            const aliasParts: string[] = [];
            for (const [token, localId] of aliasMap.entries()) {
                const session = GlobalState.sessionsByToken.get(token);
                const name = session?.character?.name ? `${session.character.name}Local` : `token${token}Local`;
                aliasParts.push(`${name}=${localId}`);
            }
            rows.push(
                `canonicalId=${Math.max(0, Math.round(Number(entity.canonicalId ?? id) || 0))} ` +
                `name=${String(entity.name ?? entity.EntName ?? '')} ` +
                `owner=${String(entity.ownerCharacterName ?? entity.combatAuthorityName ?? entity.ownerToken ?? '')} ` +
                `${aliasParts.join(' ')} hp=${Math.round(Number(entity.hp ?? 0))}`
            );
        }
        if (rows.length === 0) {
            return;
        }
        console.log(`[MultiplayerSync][alias-table] scope=${levelScope}\n  ${rows.join('\n  ')}`);
    }

    static isHomeDummyEntity(entity: any): boolean {
        return /^HomeDummy[123]$/.test(String(entity?.name ?? entity?.EntName ?? entity?.entName ?? ''));
    }

    private static shouldDeferLiveSharedHostileSeedToJoiner(joiner: Client, entity: any): boolean {
        return Boolean(joiner.currentLevel) &&
            !EntityHandler.usesServerAuthorityHostiles(joiner.currentLevel) &&
            EntityHandler.isPartySharedClientSpawnHostile(joiner.currentLevel, entity) &&
            !EntityHandler.isEntityDead(entity);
    }

    private static resolveRuntimeDungeonEntityLevel(client: Client, levelName: string | null | undefined, fallbackLevel: number = 1): number {
        if (!LevelConfig.isDungeonLevel(levelName)) {
            return Math.max(1, Math.min(50, Math.round(Number(fallbackLevel) || 1)));
        }

        return getPartyRuntimeLevelForClient(client, client.character, fallbackLevel);
    }

    private static applyRuntimeDungeonEntityLevel(client: Client, levelName: string | null | undefined, entity: any): void {
        if (!entity || entity.isPlayer || !LevelConfig.isDungeonLevel(levelName)) {
            return;
        }

        if (
            EntityHandler.usesServerAuthorityHostiles(levelName) &&
            Number(entity.team ?? 0) === EntityTeam.ENEMY &&
            !Boolean(entity.clientSpawned)
        ) {
            EntityHandler.normalizeServerAuthorityHostileState(levelName, entity);
            return;
        }

        entity.level = EntityHandler.resolveRuntimeDungeonEntityLevel(client, levelName, entity.level);
    }

    static rescaleDungeonEntitiesForParty(client: Client): number {
        const levelName = client.currentLevel;
        if (!levelName || !LevelConfig.isDungeonLevel(levelName)) {
            return 0;
        }

        const runtimeLevel = EntityHandler.resolveRuntimeDungeonEntityLevel(client, levelName, 1);
        const levelScope = getClientLevelScope(client);
        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (!levelMap) {
            return 0;
        }

        let updatedCount = 0;
        for (const [entityId, entity] of levelMap.entries()) {
            if (!entity || entity.isPlayer) {
                continue;
            }

            if (EntityHandler.isServerAuthorityHostileEntity(levelName, entity)) {
                const oldLevel = Math.round(Number(entity.level ?? 0));
                const oldHp = Math.round(Number(entity.hp ?? 0));
                const oldMaxHp = Math.round(Number(entity.maxHp ?? 0));
                EntityHandler.normalizeServerAuthorityHostileState(levelName, entity);
                for (const session of GlobalState.sessionsByToken.values()) {
                    if (!session.playerSpawned || getClientLevelScope(session) !== levelScope) {
                        continue;
                    }

                    const localEntityId = EntityHandler.resolveEntityLocalId(session, entityId);
                    const localEntity = session.entities.get(localEntityId) ?? session.entities.get(entityId);
                    if (!localEntity || localEntity.isPlayer) {
                        continue;
                    }

                    EntityHandler.normalizeServerAuthorityHostileState(levelName, localEntity);
                }
                if (
                    oldLevel !== Math.round(Number(entity.level ?? 0)) ||
                    oldHp !== Math.round(Number(entity.hp ?? 0)) ||
                    oldMaxHp !== Math.round(Number(entity.maxHp ?? 0))
                ) {
                    updatedCount++;
                    logJcMini1Authority('entity_level_rescale', {
                        entityId,
                        name: entity.name,
                        oldLevel,
                        newLevel: entity.level,
                        oldHp,
                        newHp: entity.hp,
                        oldMaxHp,
                        newMaxHp: entity.maxHp,
                        scope: levelScope,
                        character: client.character?.name ?? '',
                        token: client.token
                    });
                }
                continue;
            }

            const currentLevel = Math.max(1, Math.round(Number(entity.level ?? 0) || 1));
            if (currentLevel >= runtimeLevel) {
                continue;
            }

            entity.level = runtimeLevel;
            for (const session of GlobalState.sessionsByToken.values()) {
                if (!session.playerSpawned || getClientLevelScope(session) !== levelScope) {
                    continue;
                }

                const localEntity = session.entities.get(entityId);
                if (!localEntity || localEntity.isPlayer) {
                    continue;
                }

                localEntity.level = runtimeLevel;
            }
            updatedCount++;
        }

        return updatedCount;
    }

    private static isPrivateClientSpawnOutdoorEntity(levelName: string | null | undefined, entity: any): boolean {
        if (!levelName || !entity?.clientSpawned || entity?.isPlayer) {
            return false;
        }

        if (levelName === 'CraftTownTutorial') {
            return false;
        }

        const team = Number(entity?.team ?? 0);
        return (
            (team === 2 || team === 3) &&
            EntityHandler.usesClientSpawn(levelName) &&
            !LevelConfig.isDungeonLevel(levelName)
        );
    }

    private static isPrivateClientSpawnNpc(levelName: string | null | undefined, entity: any): boolean {
        return (
            EntityHandler.isPrivateClientSpawnOutdoorEntity(levelName, entity) &&
            Number(entity?.team ?? 0) === 3
        );
    }

    private static isSharedClientSpawnRegionActor(levelName: string | null | undefined, entity: any): boolean {
        if (!levelName || entity?.isPlayer) {
            return false;
        }

        if (Boolean(entity?.hybridCanonicalHostile) && Number(entity?.team ?? 0) === EntityTeam.ENEMY) {
            return LevelConfig.isDungeonLevel(levelName);
        }

        if (!entity?.clientSpawned) {
            return false;
        }

        if (EntityHandler.isPrivateClientSpawnOutdoorEntity(levelName, entity)) {
            return false;
        }

        const team = Number(entity?.team ?? 0);
        if (team === 2) {
            return LevelConfig.isDungeonLevel(levelName);
        }

        if (team === 3) {
            return levelName === 'CraftTownTutorial' || LevelConfig.isDungeonLevel(levelName);
        }

        return false;
    }

    private static getLevelMap(
        levelName: string | null | undefined,
        levelInstanceId: string = '',
        createIfMissing: boolean = false
    ): Map<number, any> | null {
        const rawLevelName = String(levelName ?? '');
        const scopeKey = rawLevelName.includes('#') && !levelInstanceId
            ? rawLevelName
            : getLevelScopeKey(rawLevelName, levelInstanceId);
        if (!scopeKey) {
            return null;
        }

        let levelMap = GlobalState.levelEntities.get(scopeKey) ?? null;
        if (!levelMap && createIfMissing) {
            levelMap = new Map<number, any>();
            GlobalState.levelEntities.set(scopeKey, levelMap);
        }

        return levelMap;
    }

    private static getLevelMapForClient(
        client: Pick<Client, 'currentLevel' | 'levelInstanceId'>,
        createIfMissing: boolean = false
    ): Map<number, any> | null {
        return EntityHandler.getLevelMap(client.currentLevel, client.levelInstanceId, createIfMissing);
    }

    private static isPartySharedClientSpawnHostile(levelName: string | null | undefined, entity: any): boolean {
        return EntityHandler.isSharedClientSpawnRegionActor(levelName, entity) && Number(entity?.team ?? 0) === 2;
    }

    private static findLeaderAuthoritativeClientSpawnMatch(
        levelMap: Map<number, any> | null,
        entity: any
    ): any | null {
        if (!levelMap || !entity || entity.isPlayer) {
            return null;
        }

        const targetName = EntityHandler.normalizeIdentityName(entity.name);
        const targetTeam = Number(entity.team ?? 0);
        let bestMatch: any | null = null;
        let bestDistanceSq = Number.POSITIVE_INFINITY;

        for (const candidate of levelMap.values()) {
            if (!candidate || candidate.isPlayer) {
                continue;
            }
            if (Number(candidate.team ?? 0) !== targetTeam) {
                continue;
            }
            if (EntityHandler.normalizeIdentityName(candidate.name) !== targetName) {
                continue;
            }

            const dx = Number(candidate.x ?? 0) - Number(entity.x ?? 0);
            const dy = Number(candidate.y ?? 0) - Number(entity.y ?? 0);
            const distanceSq = (dx * dx) + (dy * dy);
            if (distanceSq < bestDistanceSq) {
                bestDistanceSq = distanceSq;
                bestMatch = candidate;
            }
        }

        return bestMatch;
    }

    private static suppressFollowerLeaderAuthoritativeDungeonSpawn(
        client: Client,
        levelName: string | null | undefined,
        levelMap: Map<number, any> | null,
        entity: any
    ): boolean {
        const partyId = getPartyIdForClient(client);
        if (
            !EntityHandler.usesLeaderAuthoritativeClientSpawns(levelName) ||
            !entity ||
            entity.isPlayer ||
            (Number(entity.team ?? 0) !== 2 && Number(entity.team ?? 0) !== 3) ||
            partyId <= 0
        ) {
            return false;
        }

        const canonical =
            (levelMap && levelMap.get(Number(entity.id ?? 0))) ??
            EntityHandler.findLeaderAuthoritativeClientSpawnMatch(levelMap, entity);
        // Non-leader suppression is only valid after a canonical shared hostile
        // already exists in-scope and can replace the follower's local spawn.
        if (!canonical) {
            return false;
        }

        const localId = Math.max(0, Math.round(Number(entity.id ?? 0) || 0));
        const canonicalId = Math.max(0, Math.round(Number(canonical.id ?? 0) || 0));
        if (localId <= 0 || canonicalId <= 0) {
            return false;
        }

        if (localId !== canonicalId) {
            EntityHandler.rememberEntityAlias(client, localId, canonicalId);
            client.knownEntityIds.delete(localId);
        }
        EntityHandler.registerCanonicalHostileAlias(
            client,
            getClientLevelScope(client),
            canonical,
            localId,
            localId === canonicalId ? 'same_id_leader_spawn_match' : 'follower_spawn_match'
        );

        EntityHandler.setSharedEntityRemoteUpdatesDeferred(
            client,
            canonicalId,
            Math.round(Number(entity.v ?? 0)) !== 0
        );
        client.knownEntityIds.add(canonicalId);
        client.entities.set(localId, {
            ...entity,
            canonicalEntityId: canonicalId,
            sharedCanonicalId: canonicalId
        });
        return true;
    }

    private static getSharedClientSpawnOwnerPartyId(entity: any): number {
        const ownerSession = EntityHandler.resolveEntityOwnerSession(entity);
        if (ownerSession?.character) {
            const livePartyId = getPartyIdForClient(ownerSession);
            entity.ownerPartyId = livePartyId > 0 ? livePartyId : 0;
            return livePartyId;
        }

        const storedPartyId = Number(entity?.ownerPartyId ?? 0);
        return storedPartyId > 0 ? storedPartyId : 0;
    }

    private static findBestSharedClientSpawnCanonicalMatch(
        levelName: string,
        levelMap: Map<number, any>,
        partyId: number,
        roomId: number,
        entity: any,
        excludedOwnerToken: number,
        requireSharedRoom: boolean
    ): any | null {
        const targetName = EntityHandler.normalizeIdentityName(entity?.name);
        const targetTeam = Number(entity?.team ?? 0);
        const targetSpawnKey = String(entity?.spawnKey ?? EntityHandler.getHostileSpawnKey(getLevelScopeKey(levelName, ''), entity));
        let bestMatch: any | null = null;
        let bestDistanceSq = Number.POSITIVE_INFINITY;

        for (const candidate of levelMap.values()) {
            if (!EntityHandler.isSharedClientSpawnRegionActor(levelName, candidate)) {
                continue;
            }
            const candidateId = Math.max(0, Math.round(Number(candidate?.id ?? 0)));
            const entityId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
            if (Number(candidate?.ownerToken ?? 0) === excludedOwnerToken && candidateId === entityId) {
                continue;
            }
            if (partyId > 0) {
                if (EntityHandler.getSharedClientSpawnOwnerPartyId(candidate) !== partyId) {
                    continue;
                }
            }
            if (requireSharedRoom && !sharesRoomIds(roomId, Number(candidate?.roomId ?? -1))) {
                continue;
            }
            const candidateSpawnKey = String(candidate?.spawnKey ?? '');
            if (targetSpawnKey && candidateSpawnKey && targetSpawnKey === candidateSpawnKey) {
                return candidate;
            }
            if (EntityHandler.normalizeIdentityName(candidate?.name) !== targetName) {
                continue;
            }
            if (Number(candidate?.team ?? 0) !== targetTeam) {
                continue;
            }

            const dx = Number(candidate?.x ?? 0) - Number(entity?.x ?? 0);
            const dy = Number(candidate?.y ?? 0) - Number(entity?.y ?? 0);
            const distanceSq = (dx * dx) + (dy * dy);
            if (distanceSq < bestDistanceSq) {
                bestDistanceSq = distanceSq;
                bestMatch = candidate;
            }
        }

        return bestMatch;
    }

    private static findSharedClientSpawnCanonicalMatch(
        levelName: string,
        levelMap: Map<number, any>,
        partyId: number,
        roomId: number,
        entity: any,
        excludedOwnerToken: number
    ): any | null {
        const exactRoomMatch = EntityHandler.findBestSharedClientSpawnCanonicalMatch(
            levelName,
            levelMap,
            partyId,
            roomId,
            entity,
            excludedOwnerToken,
            true
        );
        if (exactRoomMatch) {
            return exactRoomMatch;
        }

        const targetTeam = Number(entity?.team ?? 0);
        if (partyId <= 0 || targetTeam !== 2 || !LevelConfig.isDungeonLevel(levelName)) {
            return null;
        }

        // Joiners can be in the correct dungeon instance before their room state syncs.
        return EntityHandler.findBestSharedClientSpawnCanonicalMatch(
            levelName,
            levelMap,
            partyId,
            roomId,
            entity,
            excludedOwnerToken,
            false
        );
    }

    private static estimateClientSpawnHostileMaxHp(entity: any): number {
        const explicitMaxHp = Math.max(0, Math.round(Number(entity?.maxHp ?? 0)));
        if (explicitMaxHp > 0) {
            return explicitMaxHp;
        }

        const explicitHp = Math.max(0, Math.round(Number(entity?.hp ?? 0)));
        const entType = GameData.getEntType(String(entity?.name ?? '')) ?? {};
        const rawLevel = Number(entity?.level ?? entType?.Level ?? entType?.baseLevel ?? entType?.ExpLevel ?? 1);
        const hitPointScale = Number(entity?.HitPoints ?? entity?.hitPoints ?? entType?.HitPoints ?? NaN);
        if (Number.isFinite(hitPointScale) && hitPointScale > 0) {
            return Math.max(1, Math.round(EntityHandler.getHostileBaseHpForLevel(rawLevel) * hitPointScale));
        }

        return explicitHp > 0 ? explicitHp : 1;
    }

    private static normalizeHybridClientSpawnHostileCanonical(
        client: Client,
        levelName: string | null | undefined,
        levelMap: Map<number, any> | null,
        entity: any,
        rawEntityId: number
    ): void {
        if (
            !levelName ||
            !levelMap ||
            !LevelConfig.isDungeonLevel(levelName) ||
            EntityHandler.usesServerAuthorityHostiles(levelName) ||
            !entity ||
            entity.isPlayer ||
            Number(entity.team ?? 0) !== EntityTeam.ENEMY
        ) {
            return;
        }

        const localId = Math.max(0, Math.round(Number(rawEntityId || entity.id) || 0));
        if (localId <= 0) {
            return;
        }

        const partyId = getPartyIdForClient(client);
        const roomId = Number.isFinite(Number(entity?.roomId)) ? Math.round(Number(entity.roomId)) : -1;
        entity.spawnKey = entity.spawnKey || EntityHandler.getHostileSpawnKey(getLevelScopeKey(levelName, client.levelInstanceId), entity);
        const duplicate = EntityHandler.findSharedClientSpawnCanonicalMatch(
            levelName,
            levelMap,
            partyId,
            roomId,
            entity,
            client.token
        );
        if (duplicate) {
            return;
        }

        const maxHp = EntityHandler.estimateClientSpawnHostileMaxHp(entity);
        const rawHp = Number(entity.hp ?? NaN);
        const rawDelta = Number(entity.healthDelta ?? entity.health_delta ?? NaN);
        const dead = Boolean(entity.dead) || Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD;
        const hp = dead
            ? 0
            : Number.isFinite(rawHp) && Math.round(rawHp) > 0
                ? Math.min(maxHp, Math.round(rawHp))
                : Number.isFinite(rawDelta)
                    ? Math.max(1, Math.min(maxHp, maxHp + Math.round(rawDelta)))
                    : maxHp;
        const healthDelta = hp - maxHp;

        entity.id = localId;
        entity.clientSpawned = false;
        entity.hybridCanonicalHostile = true;
        entity.canonicalEntityId = undefined;
        entity.sharedCanonicalId = undefined;
        entity.ownerToken = client.token || 0;
        entity.aiOwnerToken = client.token || 0;
        entity.ownerUserId = client.userId || 0;
        entity.ownerCharacterName = client.character?.name || '';
        entity.ownerPartyId = partyId;
        entity.roomId = roomId;
        entity.hp = hp;
        entity.maxHp = maxHp;
        entity.healthDelta = healthDelta;
        entity.health_delta = healthDelta;
        entity.dead = dead || hp <= 0;
        entity.entState = entity.dead ? EntityState.DEAD : Number(entity.entState ?? EntityState.ACTIVE);
        entity.activeBuffs = entity.activeBuffs && typeof entity.activeBuffs === 'object' && !Array.isArray(entity.activeBuffs)
            ? entity.activeBuffs
            : {};
        entity.buffStateVersion = Math.max(0, Math.round(Number(entity.buffStateVersion ?? 0)));
        EntityHandler.registerCanonicalHostileAlias(
            client,
            getLevelScopeKey(levelName, client.levelInstanceId),
            entity,
            localId,
            'owner_spawn_canonical'
        );
    }

    static rememberEntityAlias(client: Client, localEntityId: number, canonicalEntityId: number): void {
        const localId = Math.max(0, Math.round(Number(localEntityId) || 0));
        const canonicalId = Math.max(0, Math.round(Number(canonicalEntityId) || 0));
        if (localId <= 0 || canonicalId <= 0 || localId === canonicalId) {
            return;
        }

        client.entityIdAliases.set(localId, canonicalId);
    }

    static isClientOwnPlayerEntity(client: Client, levelScope: string | null | undefined, entityId: number, entity: any = null): boolean {
        const id = Math.max(0, Math.round(Number(entityId) || 0));
        if (id <= 0 || client.clientEntID <= 0 || id !== client.clientEntID || !client.character) {
            return false;
        }

        const candidate = entity ?? client.entities.get(id) ?? (levelScope ? GlobalState.levelEntities.get(levelScope)?.get(id) : null);
        if (candidate && typeof candidate === 'object') {
            if (!Boolean(candidate.isPlayer)) {
                return false;
            }

            const ownerToken = Math.round(Number(candidate.ownerToken ?? 0));
            if (ownerToken > 0 && ownerToken !== client.token) {
                return false;
            }

            const ownerUserId = Math.round(Number(candidate.ownerUserId ?? 0));
            if (ownerUserId > 0 && client.userId && ownerUserId !== client.userId) {
                return false;
            }

            const entityName = EntityHandler.normalizeIdentityName(candidate.ownerCharacterName ?? candidate.name ?? candidate.characterName);
            const characterName = EntityHandler.normalizeIdentityName(client.character?.name);
            return !entityName || !characterName || entityName === characterName;
        }

        return true;
    }

    private static isEntityOwnedByClientPlayer(client: Client, entityId: number, entity: any): boolean {
        const id = Math.max(0, Math.round(Number(entityId) || 0));
        if (id <= 0 || !entity || !Boolean(entity.isPlayer)) {
            return false;
        }

        const ownerToken = Math.round(Number(entity.ownerToken ?? 0));
        if (ownerToken > 0) {
            return ownerToken === client.token;
        }

        const ownerUserId = Math.round(Number(entity.ownerUserId ?? 0));
        if (ownerUserId > 0 && client.userId) {
            return ownerUserId === client.userId;
        }

        const entityName = EntityHandler.normalizeIdentityName(entity.ownerCharacterName ?? entity.name ?? entity.characterName);
        const characterName = EntityHandler.normalizeIdentityName(client.character?.name);
        return Boolean(characterName && entityName && entityName === characterName);
    }

    private static isPlayerEntityIdOccupiedByOther(levelScope: string, client: Client, entityId: number): boolean {
        const id = Math.max(0, Math.round(Number(entityId) || 0));
        if (!levelScope || id <= 0) {
            return false;
        }

        const levelEntity = GlobalState.levelEntities.get(levelScope)?.get(id);
        if (levelEntity && !EntityHandler.isEntityOwnedByClientPlayer(client, id, levelEntity)) {
            return true;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (other === client || getClientLevelScope(other) !== levelScope) {
                continue;
            }
            if (other.clientEntID === id && other.character) {
                return true;
            }

            const otherEntity = other.entities.get(id);
            if (otherEntity && EntityHandler.isEntityOwnedByClientPlayer(other, id, otherEntity)) {
                return true;
            }
        }

        return false;
    }

    private static isPlayerCanonicalIdFree(levelScope: string, client: Client, entityId: number): boolean {
        const id = Math.max(0, Math.round(Number(entityId) || 0));
        if (!levelScope || id <= 0) {
            return false;
        }

        const levelEntity = GlobalState.levelEntities.get(levelScope)?.get(id);
        if (levelEntity && !EntityHandler.isEntityOwnedByClientPlayer(client, id, levelEntity)) {
            return false;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (other === client || getClientLevelScope(other) !== levelScope) {
                continue;
            }
            if (other.clientEntID === id && other.character) {
                return false;
            }
            if (other.entities.has(id)) {
                return false;
            }
        }

        const localEntity = client.entities.get(id);
        return !localEntity || EntityHandler.isEntityOwnedByClientPlayer(client, id, localEntity);
    }

    private static allocateCanonicalPlayerEntityId(client: Client, levelScope: string, rawEntityId: number): number {
        const rawId = Math.max(0, Math.round(Number(rawEntityId) || 0));
        if (rawId <= 0) {
            return rawId;
        }

        if (!EntityHandler.isPlayerEntityIdOccupiedByOther(levelScope, client, rawId)) {
            return rawId;
        }

        let candidate = rawId;
        const levelMap = GlobalState.levelEntities.get(levelScope);
        for (const id of levelMap?.keys() ?? []) {
            candidate = Math.max(candidate, Math.round(Number(id) || 0));
        }
        for (const session of GlobalState.sessionsByToken.values()) {
            if (getClientLevelScope(session) !== levelScope) {
                continue;
            }
            candidate = Math.max(candidate, Math.round(Number(session.clientEntID) || 0));
            for (const id of session.entities.keys()) {
                candidate = Math.max(candidate, Math.round(Number(id) || 0));
            }
        }

        candidate = Math.max(candidate + 1, rawId + 1);
        while (!EntityHandler.isPlayerCanonicalIdFree(levelScope, client, candidate)) {
            candidate++;
        }

        return candidate;
    }

    private static migrateOwnedPlayerEntityId(client: Client, levelMap: Map<number, any> | null, rawEntityId: number, canonicalEntityId: number): void {
        const rawId = Math.max(0, Math.round(Number(rawEntityId) || 0));
        const canonicalId = Math.max(0, Math.round(Number(canonicalEntityId) || 0));
        if (rawId <= 0 || canonicalId <= 0 || rawId === canonicalId) {
            return;
        }

        const localEntity = client.entities.get(rawId);
        if (EntityHandler.isEntityOwnedByClientPlayer(client, rawId, localEntity)) {
            client.entities.delete(rawId);
            client.entities.set(canonicalId, {
                ...localEntity,
                id: canonicalId
            });
        }

        const levelEntity = levelMap?.get(rawId);
        if (EntityHandler.isEntityOwnedByClientPlayer(client, rawId, levelEntity)) {
            levelMap?.delete(rawId);
            levelMap?.set(canonicalId, {
                ...levelEntity,
                id: canonicalId
            });
        }

        client.knownEntityIds.delete(rawId);
        client.knownEntityIds.add(canonicalId);
    }

    private static getDeferredRemoteUpdateIds(client: Client): Set<number> {
        const dynamicClient = client as Client & { sharedEntityRemoteUpdateDeferredIds?: Set<number> };
        if (!dynamicClient.sharedEntityRemoteUpdateDeferredIds) {
            dynamicClient.sharedEntityRemoteUpdateDeferredIds = new Set<number>();
        }

        return dynamicClient.sharedEntityRemoteUpdateDeferredIds;
    }

    private static setSharedEntityRemoteUpdatesDeferred(
        client: Client,
        canonicalEntityId: number,
        deferred: boolean
    ): void {
        const canonicalId = Math.max(0, Math.round(Number(canonicalEntityId) || 0));
        if (canonicalId <= 0) {
            return;
        }

        const deferredIds = EntityHandler.getDeferredRemoteUpdateIds(client);
        if (deferred) {
            deferredIds.add(canonicalId);
        } else {
            deferredIds.delete(canonicalId);
        }
    }

    static markSharedEntityRemoteUpdatesReady(client: Client, canonicalEntityId: number): void {
        EntityHandler.setSharedEntityRemoteUpdatesDeferred(client, canonicalEntityId, false);
    }

    static resolveEntityLocalId(client: Client, canonicalEntityId: number): number {
        const canonicalId = Math.max(0, Math.round(Number(canonicalEntityId) || 0));
        if (canonicalId <= 0) {
            return canonicalId;
        }

        for (const [localId, mappedCanonicalId] of (client.entityIdAliases ?? new Map<number, number>()).entries()) {
            if (Math.max(0, Math.round(Number(mappedCanonicalId) || 0)) === canonicalId) {
                const mappedLocalId = Math.max(0, Math.round(Number(localId) || 0));
                if (
                    mappedLocalId > 0 &&
                    (client.entities?.has(mappedLocalId) || client.knownEntityIds?.has(mappedLocalId))
                ) {
                    return mappedLocalId;
                }
            }
        }

        return canonicalId;
    }

    static canClientResolveCanonicalEntity(client: Client, canonicalEntityId: number): boolean {
        const canonicalId = Math.max(0, Math.round(Number(canonicalEntityId) || 0));
        if (canonicalId <= 0) {
            return true;
        }

        if (EntityHandler.getDeferredRemoteUpdateIds(client).has(canonicalId)) {
            return false;
        }

        if (client.knownEntityIds?.has(canonicalId) || client.entities?.has(canonicalId)) {
            return true;
        }

        const localId = EntityHandler.resolveEntityLocalId(client, canonicalId);
        return localId !== canonicalId && Boolean(client.entities?.has(localId));
    }

    static resolveEntityAlias(client: Client, entityId: number): number {
        const localId = Math.max(0, Math.round(Number(entityId) || 0));
        if (localId <= 0) {
            return localId;
        }

        let resolvedId = localId;
        const seen = new Set<number>();
        const aliases = client.entityIdAliases ?? new Map<number, number>();
        while (aliases.has(resolvedId) && !seen.has(resolvedId)) {
            seen.add(resolvedId);
            resolvedId = Math.max(0, Math.round(Number(aliases.get(resolvedId)) || 0));
        }

        return resolvedId > 0 ? resolvedId : localId;
    }

    private static sendDeadSharedCanonicalCleanup(client: Client, localEntityId: number, entity: any, canonical: any): void {
        const localId = Math.max(0, Math.round(Number(localEntityId) || 0));
        if (localId <= 0) {
            return;
        }

        const maxHp = Math.max(
            0,
            Math.round(Number(entity?.maxHp ?? canonical?.maxHp ?? entity?.hp ?? canonical?.hp ?? 0) || 0)
        );
        if (maxHp > 0) {
            client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -maxHp));
        }
        client.send(0x07, EntityHandler.buildEntityStateDeadPayload(localId));
        client.send(0x0D, EntityHandler.buildDestroyEntityPayload(localId));
        client.entities.delete(localId);
    }

    private static syncDamagedSharedCanonicalToLocalSpawn(
        client: Client,
        localEntityId: number,
        entity: any,
        canonical: any
    ): any {
        const localId = Math.max(0, Math.round(Number(localEntityId) || 0));
        const maxHp = Math.max(0, Math.round(Number(canonical?.maxHp ?? entity?.maxHp ?? entity?.hp ?? 0) || 0));
        const canonicalHpRaw = Number(canonical?.hp);
        const canonicalHp = Number.isFinite(canonicalHpRaw)
            ? Math.max(0, Math.min(maxHp || Number.MAX_SAFE_INTEGER, Math.round(canonicalHpRaw)))
            : maxHp;
        const damageTaken = maxHp > 0 ? Math.max(0, maxHp - canonicalHp) : 0;
        if (localId > 0 && damageTaken > 0) {
            client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -damageTaken));
        }

        return {
            ...entity,
            hp: maxHp > 0 ? canonicalHp : entity?.hp,
            maxHp: maxHp > 0 ? maxHp : entity?.maxHp,
            healthDelta: maxHp > 0 ? canonicalHp - maxHp : entity?.healthDelta,
            health_delta: maxHp > 0 ? canonicalHp - maxHp : entity?.health_delta,
            dead: false,
            entState: Number(entity?.entState ?? canonical?.entState ?? EntityState.ACTIVE) === EntityState.DEAD
                ? EntityState.ACTIVE
                : Number(entity?.entState ?? canonical?.entState ?? EntityState.ACTIVE),
            combatAuthorityToken: canonical?.combatAuthorityToken,
            firstCombatAuthorityToken: canonical?.firstCombatAuthorityToken,
            combatAuthorityName: canonical?.combatAuthorityName,
            firstCombatAuthorityName: canonical?.firstCombatAuthorityName,
            combatAuthorityStartedAt: canonical?.combatAuthorityStartedAt,
            firstCombatAuthorityStartedAt: canonical?.firstCombatAuthorityStartedAt
        };
    }

    private static suppressDuplicateSharedClientSpawn(
        client: Client,
        levelName: string | null | undefined,
        levelMap: Map<number, any> | null,
        entity: any
    ): boolean {
        if (!levelName || !levelMap || !EntityHandler.isSharedClientSpawnRegionActor(levelName, entity)) {
            if (DebugConfig.enabled) {
                console.log(`[Dedup] SKIP: isSharedClientSpawnRegionActor=false for ${entity?.name} in ${levelName} (clientSpawned=${entity?.clientSpawned}, team=${entity?.team})`);
            }
            return false;
        }

        const partyId = getPartyIdForClient(client);
        entity.ownerPartyId = partyId;

        const roomId = Number.isFinite(Number(entity?.roomId)) ? Number(entity.roomId) : -1;
        const canonical = EntityHandler.findSharedClientSpawnCanonicalMatch(
            levelName,
            levelMap,
            partyId,
            roomId,
            entity,
            client.token
        );
        if (!canonical) {
            if (DebugConfig.enabled) {
                console.log(`[Dedup] NO MATCH for ${entity?.name} (id=${entity?.id}, team=${entity?.team}) in ${levelName}. LevelMap has ${levelMap.size} entities. PartyId=${partyId}, ownerToken=${client.token}`);
                for (const [cId, c] of levelMap.entries()) {
                    if (c?.clientSpawned && !c?.isPlayer) {
                        console.log(`[Dedup]   candidate id=${cId} name=${c?.name} team=${c?.team} ownerToken=${c?.ownerToken} ownerPartyId=${c?.ownerPartyId}`);
                    }
                }
            }
            return false;
        }
        if (DebugConfig.enabled) {
            console.log(`[Dedup] MATCH found! ${entity?.name} (id=${entity?.id}) -> canonical id=${canonical?.id} ownerToken=${canonical?.ownerToken}`);
        }

        const duplicateId = Number(entity?.id ?? 0);
        const canonicalId = Number(canonical?.id ?? 0);
        const levelScope = getClientLevelScope(client);
        canonical.spawnKey = canonical.spawnKey || EntityHandler.getHostileSpawnKey(levelScope, canonical);
        entity.spawnKey = entity.spawnKey || canonical.spawnKey || EntityHandler.getHostileSpawnKey(levelScope, entity);
        EntityHandler.registerCanonicalHostileAlias(
            client,
            levelScope,
            canonical,
            duplicateId,
            duplicateId === canonicalId ? 'same_id_spawn_match' : 'follower_spawn_match'
        );
        const canonicalHp = Number(canonical?.hp);
        const canonicalDead =
            Boolean(canonical?.dead) ||
            Number(canonical?.entState ?? EntityState.ACTIVE) === EntityState.DEAD ||
            (Number.isFinite(canonicalHp) && Math.round(canonicalHp) <= 0);

        if (canonicalId === duplicateId) {
            // Keep the shared canonical entity alive locally without forcing a destroy/respawn cycle.
            EntityHandler.setSharedEntityRemoteUpdatesDeferred(
                client,
                canonicalId,
                Math.round(Number(entity.v ?? 0)) !== 0
            );
            client.knownEntityIds.add(canonicalId);
            if (canonicalDead) {
                EntityHandler.sendDeadSharedCanonicalCleanup(client, duplicateId, entity, canonical);
            } else {
                const maxHp = Math.max(0, Math.round(Number(canonical?.maxHp ?? entity?.maxHp ?? entity?.hp ?? 0) || 0));
                const hp = Math.max(0, Math.round(Number(canonical?.hp ?? maxHp) || 0));
                if (maxHp > 0 && hp < maxHp) {
                    client.entities.set(
                        duplicateId,
                        EntityHandler.syncDamagedSharedCanonicalToLocalSpawn(client, duplicateId, entity, canonical)
                    );
                }
            }
            return true;
        }

        client.knownEntityIds.delete(duplicateId);
        EntityHandler.rememberEntityAlias(client, duplicateId, canonicalId);
        EntityHandler.setSharedEntityRemoteUpdatesDeferred(
            client,
            canonicalId,
            Math.round(Number(entity.v ?? 0)) !== 0
        );
        client.knownEntityIds.add(canonicalId);

        if (canonicalDead) {
            EntityHandler.sendDeadSharedCanonicalCleanup(client, duplicateId, entity, canonical);
            return true;
        }

        client.entities.set(duplicateId, {
            ...EntityHandler.syncDamagedSharedCanonicalToLocalSpawn(client, duplicateId, entity, canonical),
            canonicalEntityId: canonicalId,
            sharedCanonicalId: canonicalId
        });
        
        return true;
    }

    static shouldRelayEntityToOtherClients(levelName: string | null | undefined, entity: any): boolean {
        if (EntityHandler.isPrivateClientSpawnOutdoorEntity(levelName, entity)) {
            return false;
        }

        return !EntityHandler.isPartySharedClientSpawnHostile(levelName, entity);
    }

    static shouldMirrorClientSpawnEntityToParty(levelName: string | null | undefined, entity: any): boolean {
        return EntityHandler.isPartySharedClientSpawnHostile(levelName, entity);
    }

    static shouldTrackKnownEntity(levelName: string | null | undefined, entity: any): boolean {
        if (!entity) {
            return false;
        }
        if (!levelName) {
            return true;
        }

        return EntityHandler.shouldRelayEntityToOtherClients(levelName, entity);
    }

    private static canClientUsePartySharedClientSpawnEntity(client: Client, entity: any): boolean {
        if (!client.playerSpawned || !client.currentLevel || entity?.isPlayer) {
            return false;
        }
        if (!entity?.clientSpawned && !Boolean(entity?.hybridCanonicalHostile)) {
            return false;
        }
        if (!EntityHandler.isPartySharedClientSpawnHostile(client.currentLevel, entity)) {
            return false;
        }

        const clientPartyId = getPartyIdForClient(client);
        const ownerPartyId = EntityHandler.getSharedClientSpawnOwnerPartyId(entity);
        const ownerSession = EntityHandler.resolveEntityOwnerSession(entity);
        if (ownerSession?.playerSpawned && areClientsInSameLevelScope(client, ownerSession)) {
            if (ownerSession === client) {
                return true;
            }

            if (clientPartyId > 0 && ownerPartyId > 0 && areClientsInSameParty(client, ownerSession)) {
                return true;
            }
        }

        return clientPartyId > 0 && ownerPartyId > 0 && clientPartyId === ownerPartyId;
    }

    private static rememberEntityKnown(client: Client, levelName: string | null | undefined, entity: any): void {
        const entityId = Number(entity?.id ?? 0);
        if (entityId <= 0) {
            return;
        }

        if (
            EntityHandler.shouldTrackKnownEntity(levelName, entity) ||
            EntityHandler.canClientUsePartySharedClientSpawnEntity(client, entity)
        ) {
            client.knownEntityIds.add(entityId);
            return;
        }

        client.knownEntityIds.delete(entityId);
    }

    private static hasConflictingLocalKnownEntity(client: Client, levelName: string, entityId: number, entity: any): boolean {
        const localEntity = client.entities.get(entityId);
        if (!localEntity) {
            return false;
        }

        if (
            Boolean(localEntity?.clientSpawned) &&
            Boolean(entity?.clientSpawned) &&
            !Boolean(localEntity?.isPlayer) &&
            !Boolean(entity?.isPlayer) &&
            EntityHandler.normalizeIdentityName(localEntity?.name) === EntityHandler.normalizeIdentityName(entity?.name) &&
            Number(localEntity?.team ?? 0) === Number(entity?.team ?? 0)
        ) {
            return false;
        }

        if (EntityHandler.isPartySharedClientSpawnHostile(levelName, localEntity)) {
            return true;
        }

        if (Boolean(localEntity.isPlayer) !== Boolean(entity?.isPlayer)) {
            return true;
        }

        const localOwnerToken = Number(localEntity?.ownerToken ?? (entityId === client.clientEntID ? client.token : 0));
        const remoteOwnerToken = Number(entity?.ownerToken ?? 0);
        if (localOwnerToken > 0 && remoteOwnerToken > 0 && localOwnerToken !== remoteOwnerToken) {
            return true;
        }

        return false;
    }

    private static resolvePlayerSessionByEntityId(entityId: number, entity: any = null): Client | null {
        const ownerToken = Number(entity?.ownerToken ?? 0);
        if (ownerToken > 0) {
            const ownerSession = GlobalState.sessionsByToken.get(ownerToken);
            if (ownerSession?.clientEntID === entityId && ownerSession.character) {
                return ownerSession;
            }
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (other.clientEntID === entityId && other.character) {
                return other;
            }
        }

        return null;
    }

    private static resolveEntityOwnerSession(entity: any): Client | null {
        const ownerToken = Number(entity?.ownerToken ?? 0);
        if (ownerToken > 0) {
            const ownerSession = GlobalState.sessionsByToken.get(ownerToken);
            if (ownerSession?.character) {
                return ownerSession;
            }
        }

        return null;
    }

    private static getStartedRoomIdsForLevel(
        client: Pick<Client, 'startedRoomEvents'> | null | undefined,
        levelName: string | null | undefined
    ): number[] {
        const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
        if (!normalizedLevel || !client?.startedRoomEvents) {
            return [];
        }

        const prefix = `${normalizedLevel}:`;
        const roomIds = new Set<number>();
        for (const key of client.startedRoomEvents) {
            if (!key.startsWith(prefix)) {
                continue;
            }

            const roomId = Number(key.substring(prefix.length));
            if (Number.isFinite(roomId) && roomId >= 0) {
                roomIds.add(Math.round(roomId));
            }
        }

        return Array.from(roomIds).sort((left, right) => left - right);
    }

    private static sendRoomEventStartPacket(client: Client, roomId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod9(roomId);
        bb.writeMethod15(true);
        client.sendBitBuffer(0xA5, bb);
    }

    private static replayStartedDungeonRoomEventsToJoiner(joiner: Client): void {
        const levelName = LevelConfig.normalizeLevelName(joiner.currentLevel);
        if (!levelName || !LevelConfig.isDungeonLevel(levelName) || !joiner.playerSpawned) {
            return;
        }
        if (EntityHandler.shouldSkipDungeonRoomProgressSync(levelName)) {
            return;
        }

        let anchor: Client | null = null;
        let anchorStartedRoomIds: number[] = [];

        for (const other of GlobalState.sessionsByToken.values()) {
            if (other === joiner) {
                continue;
            }
            if (!other.playerSpawned || !areClientsInSameLevelScope(joiner, other) || !areClientsInSameParty(joiner, other)) {
                continue;
            }

            const startedRoomIds = EntityHandler.getStartedRoomIdsForLevel(other, levelName);
            if (startedRoomIds.length === 0) {
                continue;
            }

            if (
                !anchor ||
                startedRoomIds.length > anchorStartedRoomIds.length ||
                (startedRoomIds.length === anchorStartedRoomIds.length && Number(other.syncAnchorStartedAt ?? 0) > Number(anchor.syncAnchorStartedAt ?? 0))
            ) {
                anchor = other;
                anchorStartedRoomIds = startedRoomIds;
            }
        }

        if (!anchor || anchorStartedRoomIds.length === 0) {
            return;
        }

        const anchorRoomId = Number(anchor.currentRoomId ?? -1);
        if (Number.isFinite(anchorRoomId) && anchorRoomId >= 0) {
            joiner.currentRoomId = anchorRoomId;
        }

        for (const roomId of anchorStartedRoomIds) {
            const key = `${levelName}:${roomId}`;
            if (joiner.startedRoomEvents.has(key)) {
                continue;
            }

            EntityHandler.sendRoomEventStartPacket(joiner, roomId);
            joiner.startedRoomEvents.add(key);
        }
    }

    static resolveCanonicalEntity(levelName: string, entityId: number): EntityProps | null {
        if (!levelName || entityId <= 0) {
            return null;
        }

        const entity = EntityHandler.getLevelMap(levelName)?.get(entityId);
        if (!entity) {
            return null;
        }

        if (entity.isPlayer) {
            const ownerSession = EntityHandler.resolvePlayerSessionByEntityId(entityId, entity);
            if (ownerSession?.character) {
                return Entity.fromCharacter(entityId, ownerSession.character, entity);
            }
        }

        if (entity.id && entity.entState !== undefined) {
            return entity as EntityProps;
        }

        return Entity.fromNpc(entity);
    }

    static canClientSeeEntity(client: Client, entity: any): boolean {
        if (!client.playerSpawned || !client.currentLevel || !entity) {
            return false;
        }

        if (entity.isPlayer) {
            return true;
        }

        if (EntityHandler.isPartySharedClientSpawnHostile(client.currentLevel, entity)) {
            return EntityHandler.canClientUsePartySharedClientSpawnEntity(client, entity);
        }

        if (!EntityHandler.shouldRelayEntityToOtherClients(client.currentLevel, entity)) {
            return false;
        }

        if (entity.clientSpawned) {
            const clientPartyId = getPartyIdForClient(client);
            const ownerPartyId = EntityHandler.getSharedClientSpawnOwnerPartyId(entity);
            if (clientPartyId > 0 && ownerPartyId > 0 && clientPartyId === ownerPartyId) {
                return true;
            }

            const ownerSession = EntityHandler.resolveEntityOwnerSession(entity);
            if (ownerSession && areClientsInSameLevelScope(client, ownerSession) && areClientsInSameParty(client, ownerSession)) {
                return true;
            }

            const entityRoomId = Number.isFinite(Number(entity?.roomId)) ? Number(entity.roomId) : -1;
            return sharesRoomIds(client.currentRoomId, entityRoomId);
        }

        return true;
    }

    static ensureEntityKnown(client: Client, levelName: string, entityId: number): boolean {
        if (entityId <= 0) {
            return true;
        }

        const entity = EntityHandler.getLevelMap(levelName, client.levelInstanceId)?.get(entityId);
        if (!entity || !EntityHandler.canClientSeeEntity(client, entity)) {
            return false;
        }

        if (client.knownEntityIds.has(entityId)) {
            if (!EntityHandler.hasConflictingLocalKnownEntity(client, levelName, entityId, entity)) {
                return true;
            }

            client.knownEntityIds.delete(entityId);
        }

        const snapshot = EntityHandler.resolveCanonicalEntity(getLevelScopeKey(levelName, client.levelInstanceId), entityId);
        if (!snapshot) {
            return false;
        }

        EntityHandler.sendEntity(client, snapshot);
        return true;
    }

    static forgetKnownEntity(levelName: string, entityId: number, levelInstanceId: string = ''): void {
        if (!levelName || entityId <= 0) {
            return;
        }

        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);
        for (const other of GlobalState.sessionsByToken.values()) {
            if (getClientLevelScope(other) === scopeKey) {
                other.knownEntityIds.delete(entityId);
            }
        }
    }

    private static buildEntityFullUpdatePayload(entity: EntityProps): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entity.id);
        bb.writeMethod24(Math.round(Number(entity.x ?? 0)));
        bb.writeMethod24(Math.round(Number(entity.y ?? 0)));
        bb.writeMethod24(Math.round(Number(entity.v ?? 0)));
        bb.writeMethod26(entity.name ?? '');
        bb.writeMethod6(Number(entity.team ?? 0), Entity.TEAM_BITS);
        bb.writeMethod15(Boolean(entity.isPlayer));
        bb.writeMethod706(Math.round(Number(entity.renderDepthOffset ?? 0)));

        const characterName = String(entity.characterName ?? '');
        const dramaAnim = String(entity.dramaAnim ?? '');
        const sleepAnim = String(entity.sleepAnim ?? '');
        const hasCue = Boolean(characterName || dramaAnim || sleepAnim);
        bb.writeMethod15(hasCue);
        if (hasCue) {
            bb.writeMethod15(Boolean(characterName));
            if (characterName) {
                bb.writeMethod13(characterName);
            }
            bb.writeMethod15(Boolean(dramaAnim));
            if (dramaAnim) {
                bb.writeMethod13(dramaAnim);
            }
            bb.writeMethod15(Boolean(sleepAnim));
            if (sleepAnim) {
                bb.writeMethod13(sleepAnim);
            }
        }

        const summonerId = Number(entity.summonerId ?? 0);
        bb.writeMethod15(summonerId > 0);
        if (summonerId > 0) {
            bb.writeMethod4(summonerId);
        }

        const powerId = Number(entity.powerId ?? 0);
        bb.writeMethod15(powerId > 0);
        if (powerId > 0) {
            bb.writeMethod4(powerId);
        }

        bb.writeMethod6(Number(entity.entState ?? EntityState.ACTIVE), Entity.STATE_BITS);
        bb.writeMethod15(Boolean(entity.facingLeft));
        bb.writeMethod15(Boolean(entity.running));
        bb.writeMethod15(Boolean(entity.jumping));
        bb.writeMethod15(Boolean(entity.dropping));
        bb.writeMethod15(Boolean(entity.backpedal));
        return bb.toBuffer();
    }

    static isClientSpawnLevel(levelName: string): boolean {
        if (EntityHandler.usesServerAuthorityHostiles(levelName)) {
            return false;
        }

        return EntityHandler.usesClientSpawn(levelName);
    }

    private static pruneStaleServerNpcs(levelMap: Map<number, any>): number {
        let removedCount = 0;

        for (const [entityId, entityProps] of Array.from(levelMap.entries())) {
            if (entityProps?.isPlayer || entityProps?.clientSpawned) {
                continue;
            }

            levelMap.delete(entityId);
            removedCount++;
        }

        return removedCount;
    }

    private static getCraftTownTutorialState(client: Client) {
        if (client.currentLevel !== 'CraftTownTutorial') {
            return null;
        }

        if (!client.keepTutorialState) {
            client.keepTutorialState = createKeepTutorialState();
        }

        return client.keepTutorialState;
    }

    private static sendStartSkit(client: Client, entityId: number, dialogueId: number, missionId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod6(dialogueId, 3);
        bb.writeMethod4(missionId);
        MissionHandler.noteDungeonSkitActivity(client);
        client.sendBitBuffer(0x7B, bb);
    }

    private static sendRoomBossInfo(
        levelName: string,
        roomId: number,
        bossId: number,
        bossName: string,
        levelInstanceId: string = ''
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(Math.max(0, roomId));
        bb.writeMethod4(bossId);
        bb.writeMethod26(bossName);
        bb.writeMethod4(0);
        bb.writeMethod26('');
        const payload = bb.toBuffer();

        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);
        markRoomBossEntity(scopeKey, bossId, roomId, bossName);
        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== scopeKey) {
                continue;
            }
            other.send(0xAC, payload);
        }
        noteDungeonRunBossCutscene(scopeKey, roomId, bossId);
    }

    private static sendRoomSound(
        levelName: string,
        roomId: number,
        soundName: string,
        volume: number,
        levelInstanceId: string = ''
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(Math.max(0, roomId));
        bb.writeMethod13(soundName);
        bb.writeMethod4(Math.max(0, Math.min(100, Math.round(volume * 100))));
        const payload = bb.toBuffer();

        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);
        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== scopeKey) {
                continue;
            }
            other.send(0xA8, payload);
        }
    }

    private static sendNpcState(client: Client, entityId: number, entState: number, facingLeft: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(0);
        bb.writeMethod45(0);
        bb.writeMethod45(0);
        bb.writeMethod6(entState, 2);
        bb.writeMethod15(facingLeft);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        client.sendBitBuffer(0x07, bb);
    }

    static sendNpcMove(client: Client, entityId: number, dx: number, dy: number, state: number = 0, facingLeft: boolean = false): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(dx);
        bb.writeMethod45(dy);
        bb.writeMethod45(0); // deltaV
        bb.writeMethod6(state, 2);
        bb.writeMethod15(facingLeft);
        bb.writeMethod15(false); // running
        bb.writeMethod15(false); // jumping
        bb.writeMethod15(false); // dropping
        bb.writeMethod15(false); // backpedal
        bb.writeMethod15(false); // airborne
        client.sendBitBuffer(0x07, bb);
    }

    private static sendSetUntargetable(client: Client, entityId: number, untargetable: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod15(untargetable);
        client.sendBitBuffer(0xAE, bb);
    }

    private static sendDestroyEntity(client: Client, entityId: number): void {
        client.send(0x0D, EntityHandler.buildDestroyEntityPayload(entityId));
    }

    private static buildEntityStateDeadPayload(entityId: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(0);
        bb.writeMethod45(0);
        bb.writeMethod45(0);
        bb.writeMethod6(3, 2); // EntityState.DEAD = 3
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        return bb.toBuffer();
    }

    private static buildDestroyEntityPayload(entityId: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod15(true);
        return bb.toBuffer();
    }

    static broadcastDestroyEntity(
        levelName: string,
        entityId: number,
        excludedClient: Client | null = null,
        levelInstanceId: string = '',
        entityProps: any = null
    ): void {
        if (!levelName || entityId <= 0) {
            return;
        }

        const payload = EntityHandler.buildDestroyEntityPayload(entityId);
        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);
        const destroyedEntity = entityProps ?? EntityHandler.getLevelMap(levelName, levelInstanceId)?.get(entityId) ?? null;
        for (const other of GlobalState.sessionsByToken.values()) {
            if (
                other === excludedClient ||
                !other.playerSpawned ||
                getClientLevelScope(other) !== scopeKey ||
                other.socket?.destroyed
            ) {
                continue;
            }

            if (destroyedEntity && !destroyedEntity.isPlayer) {
                if (EntityHandler.shouldRelayEntityToOtherClients(levelName, destroyedEntity)) {
                    if (!EntityHandler.canClientSeeEntity(other, destroyedEntity)) {
                        continue;
                    }
                } else if (EntityHandler.shouldMirrorClientSpawnEntityToParty(levelName, destroyedEntity)) {
                    if (!EntityHandler.canClientUsePartySharedClientSpawnEntity(other, destroyedEntity)) {
                        continue;
                    }
                } else {
                    continue;
                }
            }

            other.knownEntityIds?.delete(entityId);
            other.send(0x0D, payload);
        }
    }

    private static getEquippedMountId(value: unknown): number {
        const mountId = Number(value ?? 0);
        return Number.isFinite(mountId) && mountId > 0 ? mountId : 0;
    }

    private static sendMountState(client: Client, entityId: number, mountId: number): void {
        if (entityId <= 0 || mountId <= 0) {
            return;
        }

        PetHandler.sendMountEquipPacket(client, entityId, mountId);
    }

    private static scheduleSelfMountSync(client: Client, entityId: number, mountId: number): void {
        if (entityId <= 0 || mountId <= 0) {
            return;
        }

        const levelScope = getClientLevelScope(client);
        const token = client.token;
        for (const delayMs of EntityHandler.MOUNT_SYNC_RETRY_DELAYS_MS) {
            setTimeout(() => {
                if (
                    !client.playerSpawned ||
                    getClientLevelScope(client) !== levelScope ||
                    client.token !== token ||
                    client.clientEntID !== entityId
                ) {
                    return;
                }

                EntityHandler.sendMountState(client, entityId, mountId);
            }, delayMs);
        }
    }

    private static scheduleExistingVisibleClientSpawnEntitiesToJoiner(joiner: Client): void {
        const levelScope = getClientLevelScope(joiner);
        const token = joiner.token;
        for (const delayMs of EntityHandler.CLIENT_SPAWN_JOINER_SEED_DELAYS_MS) {
            setTimeout(() => {
                if (!joiner.playerSpawned || getClientLevelScope(joiner) !== levelScope || joiner.token !== token) {
                    return;
                }

                EntityHandler.sendExistingVisibleClientSpawnEntitiesToJoiner(joiner);
            }, delayMs);
        }
    }

    private static buildPlayerSnapshot(client: Client): EntityProps | null {
        if (!client.character || !client.currentLevel) {
            return null;
        }

        const entityId = Number(client.clientEntID || 0);
        if (entityId <= 0) {
            return null;
        }

        const current = client.entities.get(entityId) ?? EntityHandler.getLevelMapForClient(client)?.get(entityId) ?? {};
        const playerEntity = Entity.fromCharacter(entityId, client.character, {
            ...current,
            roomId: client.currentRoomId
        });
        const persistedEntity = {
            ...current,
            ...playerEntity,
            clientSpawned: false,
            ownerToken: client.token || 0,
            ownerUserId: client.userId || 0,
            roomId: client.currentRoomId
        };

        client.entities.set(entityId, persistedEntity);
        EntityHandler.rememberEntityKnown(client, client.currentLevel, persistedEntity);
        let levelMap = EntityHandler.getLevelMapForClient(client);
        if (!levelMap) {
            levelMap = EntityHandler.getLevelMapForClient(client, true) ?? new Map<number, any>();
        }
        levelMap.set(entityId, persistedEntity);

        return playerEntity;
    }

    private static sendOtherPlayerMountToJoiner(joiner: Client, other: Client): void {
        if (!other.character || other.clientEntID <= 0) {
            return;
        }

        const mountId = EntityHandler.getEquippedMountId(other.character.equippedMount);
        EntityHandler.sendMountState(joiner, other.clientEntID, mountId);
    }

    private static broadcastPlayerMountState(client: Client, entityId: number, mountId: number): void {
        if (!client.currentLevel || mountId <= 0) {
            return;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (other === client || !other.playerSpawned || !areClientsInSameLevelScope(client, other)) {
                continue;
            }

            EntityHandler.sendMountState(other, entityId, mountId);
        }
    }

    private static suppressCraftTownTutorialBoss(client: Client, entityId: number): void {
        client.entities.delete(entityId);
        EntityHandler.getLevelMapForClient(client)?.delete(entityId);
        EntityHandler.sendDestroyEntity(client, entityId);
    }

    private static handleCraftTownTutorialEntitySeen(client: Client, entityId: number, entityName: string, entity: any = null): void {
        const state = EntityHandler.getCraftTownTutorialState(client);
        if (!state) {
            return;
        }

        const dramaAnim = String(entity?.dramaAnim ?? entity?.DramaAnim ?? '');

        if (entityName === 'IntroParrot' && !state.introSkitSent) {
            EntityHandler.sendStartSkit(client, entityId, 0, 5);
            state.introSkitSent = true;
        }

        if (entityName === 'GoblinDagger' && dramaAnim === 'Board') {
            if (!EntityHandler.getCraftTownTutorialAuthoredHelperIds().has(entityId)) {
                return;
            }
            if (!state.helperEntityIds.includes(entityId)) {
                state.helperEntityIds.push(entityId);
            }
            return;
        }

        if (entityName !== 'GoblinShamanHood' && entityName !== 'IntroGoblinShamanHood') {
            return;
        }

        if (
            state.bossEntitySource === 'fallback' &&
            state.bossEntitySeen !== null &&
            state.bossEntitySeen !== entityId
        ) {
            EntityHandler.suppressCraftTownTutorialBoss(client, entityId);
            return;
        }

        if (entityName === 'GoblinShamanHood' && !state.bossIntroForced) {
            // The plain boss art should not be visible before the keep intro begins.
            EntityHandler.suppressCraftTownTutorialBoss(client, entityId);
            return;
        }

        state.bossEntitySeen = entityId;
        state.bossEntitySource = 'client';

        if (!state.bossInfoSentIds.has(entityId)) {
            EntityHandler.sendRoomBossInfo(
                client.currentLevel,
                client.currentRoomId,
                entityId,
                'Ranik, The Geomancer',
                client.levelInstanceId
            );
            state.bossInfoSentIds.add(entityId);
        }

        if (!state.bossMusicStarted) {
            EntityHandler.sendRoomSound(
                client.currentLevel,
                client.currentRoomId,
                'D02_MoodLoop_GoblinHideout',
                0.9,
                client.levelInstanceId
            );
            state.bossMusicStarted = true;
        }
    }
    
    // Server -> Client: Spawn Entity (Packet 0xF)
    static sendEntity(client: Client, entity: EntityProps | any): void {
        let props: EntityProps;
        
        if (entity.id && entity.entState !== undefined) {
             props = entity as EntityProps;
        } else {
             // Fallback for NpcDef or other objects
             props = Entity.fromNpc(entity);
        }
        
        const serializedProps = {
            ...props,
            // Flash treats nonzero spawn velocity as "hidden until first
            // movement update"; visible seed spawns avoid a join-time gfx race.
            v: 0
        };
        const data = Entity.serialize(serializedProps);
        client.send(0xF, data);
        EntityHandler.rememberEntityKnown(client, client.currentLevel, props);
        if (EntityHandler.isServerAuthorityHostileEntity(client.currentLevel, props)) {
            const entityId = Math.max(0, Math.round(Number(props.id ?? 0)));
            const localEntityId = EntityHandler.resolveEntityLocalId(client, entityId);
            logJcMini1Authority('entity_send_to_viewer', {
                packetId: '0x0F',
                entityId,
                localEntityId,
                name: props.name,
                roomId: props.roomId,
                entityLevel: props.level,
                hp: Math.round(Number((props as any).hp ?? 0)),
                maxHp: Math.round(Number((props as any).maxHp ?? 0)),
                healthDelta: Math.round(Number(props.healthDelta ?? 0)),
                dead: Boolean((props as any).dead),
                entState: props.entState,
                scope: getClientLevelScope(client),
                viewer: client.character?.name ?? '',
                viewerToken: client.token,
                viewerRoomId: client.currentRoomId,
                playerLevel: Math.round(Number(client.character?.level ?? 0)),
                playerHp: Math.round(Number(client.authoritativeCurrentHp ?? 0)),
                playerMaxHp: Math.round(Number(client.authoritativeMaxHp ?? 0)),
                knownCanonical: client.knownEntityIds.has(entityId),
                knownLocal: client.knownEntityIds.has(localEntityId),
                hasCanonicalEntity: client.entities.has(entityId),
                hasLocalEntity: client.entities.has(localEntityId)
            });
        }
    }

    // Deprecated: use sendEntity
    static sendNpc(client: Client, npc: NpcDef): void {
        this.sendEntity(client, npc);
    }

    // 0x8
    static handleEntityFullUpdate(client: Client, data: Buffer): void {
        const br = new BitReader(data);

        const rawEntityId = br.readMethod9();
        let entityId = rawEntityId;
        const posX = br.readMethod24();
        const posY = br.readMethod24();
        const velocityX = br.readMethod24();
        let entName = br.readMethod26();

        const team = br.readMethod20(Entity.TEAM_BITS);
        const isPlayer = br.readMethod15(); // bool
        const yOffset = br.readMethod706();

        // Optional Cue Data
        const hasCue = br.readMethod15();
        const cueData: any = {};
        if (hasCue) {
            if (br.readMethod15()) {
                cueData["character_name"] = br.readMethod13();
                // Comma-prefixed character_name overrides entity type for server identification
                const cname = String(cueData["character_name"] ?? '');
                if (cname.startsWith(',')) {
                    const overrideName = cname.substring(1);
                    if (overrideName) {
                        entName = overrideName;
                    }
                }
            }
            if (br.readMethod15()) {
                cueData["DramaAnim"] = br.readMethod13();
            }
            if (br.readMethod15()) {
                cueData["SleepAnim"] = br.readMethod13();
            }
        }

        const hasSummoner = br.readMethod15();
        let summonerId = 0;
        if (hasSummoner) {
            summonerId = br.readMethod9();
        }

        const hasPower = br.readMethod15();
        let powerId = 0;
        if (hasPower) {
            powerId = br.readMethod9();
        }

        const entState = br.readMethod20(Entity.STATE_BITS);

        const bLeft = br.readMethod15();
        const bRunning = br.readMethod15();
        const bJumping = br.readMethod15();
        const bDropping = br.readMethod15();
        const bBackpedal = br.readMethod15();

        const levelName = LevelConfig.normalizeLevelName(client.currentLevel) || client.currentLevel;
        if (levelName) {
            EntityHandler.ensureJcMini1PartySharedScope(client, levelName, 'entity_full_update');
        }
        const existingLevelMap = levelName ? EntityHandler.getLevelMap(levelName, client.levelInstanceId) : null;

        const entNameNorm = EntityHandler.normalizeIdentityName(entName);
        const charNameNorm = EntityHandler.normalizeIdentityName(client.character?.name);
        const isSelfPacket = Boolean(isPlayer && entNameNorm && charNameNorm && entNameNorm === charNameNorm);

        if (isPlayer && levelName && isSelfPacket) {
            const levelScope = getClientLevelScope(client);
            const canonicalEntityId = EntityHandler.allocateCanonicalPlayerEntityId(client, levelScope, rawEntityId);
            if (canonicalEntityId !== rawEntityId) {
                EntityHandler.rememberEntityAlias(client, rawEntityId, canonicalEntityId);
                EntityHandler.migrateOwnedPlayerEntityId(client, existingLevelMap, rawEntityId, canonicalEntityId);
            }
            entityId = canonicalEntityId;
            client.clientEntID = canonicalEntityId;
        } else if (isPlayer && client.clientEntID === 0) {
            client.clientEntID = entityId;
        }

        const ownsThisPlayerPacket = Boolean(
            isPlayer &&
            client.character &&
            (isSelfPacket || (client.clientEntID > 0 && client.clientEntID === entityId))
        );

        const props: EntityProps & {
            clientSpawned?: boolean;
            ownerToken?: number;
            ownerUserId?: number;
            ownerPartyId?: number;
        } = ownsThisPlayerPacket
            ? {
                ...Entity.fromCharacter(entityId, client.character!, {
                    x: posX,
                    y: posY,
                    v: velocityX,
                team,
                entState,
                facingLeft: bLeft,
                running: bRunning,
                jumping: bJumping,
                dropping: bDropping,
                backpedal: bBackpedal,
                renderDepthOffset: yOffset,
                roomId: client.currentRoomId
                }),
                characterName: cueData.character_name,
                dramaAnim: cueData.DramaAnim,
                sleepAnim: cueData.SleepAnim,
                summonerId,
                powerId,
                running: bRunning,
                jumping: bJumping,
                dropping: bDropping,
                backpedal: bBackpedal,
                clientSpawned: false,
                ownerToken: client.token || 0,
                ownerUserId: client.userId || 0,
                ownerCharacterName: client.character?.name || '',
                ownerPartyId: getPartyIdForClient(client),
                roomId: client.currentRoomId
            }
            : {
                id: entityId,
                name: entName,
                isPlayer: isPlayer,
                x: posX,
                y: posY,
                v: velocityX,
                team: team,
                renderDepthOffset: yOffset,
                characterName: cueData.character_name,
                dramaAnim: cueData.DramaAnim,
                sleepAnim: cueData.SleepAnim,
                summonerId: summonerId,
                powerId: powerId,
                entState: entState,
                facingLeft: bLeft,
                running: bRunning,
                jumping: bJumping,
                dropping: bDropping,
                backpedal: bBackpedal,
                clientSpawned: !isPlayer,
                ownerToken: client.token || 0,
                ownerUserId: client.userId || 0,
                ownerCharacterName: client.character?.name || '',
                ownerPartyId: getPartyIdForClient(client),
                roomId: client.currentRoomId
                // bRunning etc are flags
            };

        EntityHandler.applyRuntimeDungeonEntityLevel(client, levelName, props);

        if (!isPlayer) {
            client.clientSpawnConfirmed = true;
            clearClientSpawnFallbackTimer(client);
            if (client.currentLevel === 'CraftTownTutorial') {
                EntityHandler.handleCraftTownTutorialEntitySeen(client, entityId, String(props.name ?? ''), props);
            }
        }

        let levelMap = existingLevelMap;
        if (levelName) {
            if (!levelMap) {
                levelMap = EntityHandler.getLevelMapForClient(client, true) ?? new Map<number, any>();
            }
        }

        if (EntityHandler.suppressServerAuthorityClientHostileSpawn(client, levelName, props, rawEntityId)) {
            return;
        }

        EntityHandler.normalizeHybridClientSpawnHostileCanonical(client, levelName, levelMap, props, rawEntityId);

        if (EntityHandler.suppressFollowerLeaderAuthoritativeDungeonSpawn(client, levelName, levelMap, props)) {
            return;
        }

        if (EntityHandler.suppressDuplicateSharedClientSpawn(client, levelName, levelMap, props)) {
            return;
        }

        if (!isPlayer && levelName && DebugConfig.enabled) {
            console.log(`[EntityHandler] Non-player entity ACCEPTED: id=${entityId} name=${entName} team=${team} from ${client.character?.name} in ${levelName} scope=${getClientLevelScope(client)} levelMap.size=${levelMap?.size ?? 'null'}`);
        }

        client.entities.set(entityId, props);
        noteDungeonRunEntitySeen(client, entityId, props);
        EntityHandler.rememberEntityKnown(client, levelName, props);

        // Update GlobalState
        if (levelMap) {
            levelMap.set(entityId, props);
        }

        // Broadcast the normalized snapshot so remote clients receive canonical state.
        EntityHandler.broadcastToLevel(client, EntityHandler.buildEntityFullUpdatePayload(props), props);

        if (isPlayer && !client.playerSpawned) {
             client.playerSpawned = true;
             client.mountTransferGraceUntil = Math.max(client.mountTransferGraceUntil, Date.now() + 4000);
             const equippedMountId = EntityHandler.getEquippedMountId(
                client.character?.equippedMount ?? props.equippedMount ?? 0
            );
             EntityHandler.scheduleSelfMountSync(client, client.clientEntID, equippedMountId);
             EntityHandler.sendExistingPlayersToJoiner(client);
             EntityHandler.broadcastPlayerSpawn(client, props);
             EntityHandler.broadcastPlayerMountState(client, props.id, equippedMountId);
             BuildingHandler.refreshCraftTownBuildingsOnSpawn(client);
        }
    }

    static sendInitialLevelEntities(client: Client, levelName: string): void {
        levelName = LevelConfig.normalizeLevelName(levelName) || levelName;
        EntityHandler.ensureJcMini1PartySharedScope(client, levelName, 'send_initial_level_entities');
        console.log(`[EntityHandler] Sending initial entities for ${levelName} to ${client.character?.name}`);
        EntityHandler.dumpHostileAliasTable(getLevelScopeKey(levelName, client.levelInstanceId));
        
        let levelMap = EntityHandler.getLevelMap(levelName, client.levelInstanceId);
        if (!levelMap) {
            levelMap = EntityHandler.getLevelMap(levelName, client.levelInstanceId, true) ?? new Map<number, any>();

            if (EntityHandler.usesClientSpawn(levelName)) {
                console.log(`[EntityHandler] Skipping server NPC init for client-spawn level ${levelName}`);
            } else {
                const npcs = NpcLoader.getNpcsForLevel(levelName);
                console.log(`[EntityHandler] Initializing ${npcs.length} NPCs for ${levelName}`);

                for (const npc of npcs) {
                    const entityProps = EntityHandler.usesServerAuthorityHostiles(levelName)
                        ? EntityHandler.createServerAuthorityEntityFromNpc(client, levelName, npc)
                        : {
                            ...Entity.fromNpc(npc),
                            clientSpawned: false
                        };
                    EntityHandler.applyRuntimeDungeonEntityLevel(client, levelName, entityProps);
                    levelMap.set(npc.id, entityProps);
                }
            }
        }

        if (EntityHandler.usesServerAuthorityHostiles(levelName)) {
            EntityHandler.resetServerAuthorityScopeForFreshRun(client, levelName, levelMap);
            EntityHandler.seedServerAuthorityHostiles(client, levelName, levelMap);
        }

        const clientSpawnLevel = EntityHandler.usesClientSpawn(levelName);
        const serverAuthorityHostiles = EntityHandler.usesServerAuthorityHostiles(levelName);
        const canonicalVisibleServerAuthority = EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelName);
        if (clientSpawnLevel) {
            const removedCount = EntityHandler.pruneStaleServerNpcs(levelMap);
            if (removedCount > 0) {
                console.log(
                    `[EntityHandler] Removed ${removedCount} stale server NPCs from client-spawn level ${levelName}`
                );
            }
            if (!serverAuthorityHostiles) {
                return;
            }
        }

        for (const [id, entityProps] of levelMap.entries()) {
            if (id === client.clientEntID) continue;
            if (entityProps?.isPlayer) continue;
            if (EntityHandler.isEntityDead(entityProps)) continue;
            if (entityProps?.clientSpawned) continue;
            EntityHandler.normalizeServerAuthorityHostileState(levelName, entityProps);
            if (EntityHandler.isServerAuthorityHostileEntity(levelName, entityProps)) {
                noteDungeonRunEntitySeen(client, id, entityProps);
                const canonicalDead = Boolean((entityProps as any).dead) ||
                    Number(entityProps.entState ?? EntityState.ACTIVE) === EntityState.DEAD;
                if (!canonicalVisibleServerAuthority) {
                    logJcMini1Authority('joiner_enemy_snapshot', {
                        entityId: id,
                        localEntityId: EntityHandler.resolveEntityLocalId(client, id),
                        name: entityProps.name,
                        roomId: entityProps.roomId,
                        entityLevel: entityProps.level,
                        hp: Math.round(Number((entityProps as any).hp ?? 0)),
                        maxHp: Math.round(Number((entityProps as any).maxHp ?? 0)),
                        healthDelta: Math.round(Number(entityProps.healthDelta ?? 0)),
                        dead: Boolean((entityProps as any).dead),
                        entState: entityProps.entState,
                        scope: getLevelScopeKey(levelName, client.levelInstanceId),
                        viewer: client.character?.name ?? '',
                        viewerToken: client.token,
                        viewerRoomId: client.currentRoomId,
                        playerLevel: Math.round(Number(client.character?.level ?? 0)),
                        playerHp: Math.round(Number(client.authoritativeCurrentHp ?? 0)),
                        playerMaxHp: Math.round(Number(client.authoritativeMaxHp ?? 0)),
                        knownCanonical: client.knownEntityIds.has(id),
                        visibleSnapshotSent: false,
                        reason: canonicalDead ? 'dead_wait_for_proxy_cleanup' : 'live_wait_for_client_proxy'
                    });
                    continue;
                }
                logJcMini1Authority('joiner_enemy_snapshot', {
                    entityId: id,
                    localEntityId: EntityHandler.resolveEntityLocalId(client, id),
                    name: entityProps.name,
                    roomId: entityProps.roomId,
                    entityLevel: entityProps.level,
                    hp: Math.round(Number((entityProps as any).hp ?? 0)),
                    maxHp: Math.round(Number((entityProps as any).maxHp ?? 0)),
                    healthDelta: Math.round(Number(entityProps.healthDelta ?? 0)),
                    dead: Boolean((entityProps as any).dead),
                    entState: entityProps.entState,
                    scope: getLevelScopeKey(levelName, client.levelInstanceId),
                    viewer: client.character?.name ?? '',
                    viewerToken: client.token,
                    viewerRoomId: client.currentRoomId,
                    playerLevel: Math.round(Number(client.character?.level ?? 0)),
                    playerHp: Math.round(Number(client.authoritativeCurrentHp ?? 0)),
                    playerMaxHp: Math.round(Number(client.authoritativeMaxHp ?? 0)),
                    knownCanonical: client.knownEntityIds.has(id),
                    visibleSnapshotSent: false,
                    reason: canonicalDead ? 'dead_wait_for_client_proxy_cleanup' : 'live_wait_for_client_proxy_bridge'
                });
                continue;
            }
            client.entities.set(id, { ...entityProps });
            noteDungeonRunEntitySeen(client, id, entityProps);
            EntityHandler.sendEntity(client, entityProps);
        }
    }

    static removeOwnedEntities(client: Client): number[] {
        const levelName = client.currentLevel;
        if (!levelName) {
            return [];
        }

        const removedEntityIds = new Set<number>();
        const removedEntityProps = new Map<number, any>();
        const levelMap = EntityHandler.getLevelMap(levelName, client.levelInstanceId);
        const charNameNorm = EntityHandler.normalizeIdentityName(client.character?.name);

        if (levelMap) {
            for (const [entityId, entityProps] of Array.from(levelMap.entries())) {
                const entityNameNorm = EntityHandler.normalizeIdentityName(entityProps?.name);
                if (
                    EntityHandler.isServerAuthorityHostileEntity(levelName, entityProps) &&
                    (
                        Math.max(0, Math.round(Number(entityProps?.ownerToken ?? 0))) === client.token ||
                        Math.max(0, Math.round(Number(entityProps?.aiOwnerToken ?? 0))) === client.token ||
                        Math.max(0, Math.round(Number(entityProps?.proxyOwnerToken ?? 0))) === client.token
                    )
                ) {
                    console.log(
                        `[MultiplayerSync][hostile-lifecycle-preserve-on-leave] scope=${getClientLevelScope(client)} canonicalId=${Math.max(0, Math.round(Number(entityId) || 0))} leavingToken=${client.token} dead=${Boolean(entityProps?.dead)} destroyed=${Boolean(entityProps?.destroyed)}`
                    );
                }
                const isOwnedPlayer = Boolean(entityProps?.isPlayer) && (
                    (client.clientEntID > 0 && entityId === client.clientEntID) ||
                    (charNameNorm && entityNameNorm === charNameNorm)
                );
                const isOwnedClientSpawn =
                    Boolean(entityProps?.clientSpawned) &&
                    Number(entityProps?.ownerToken ?? 0) === client.token &&
                    !EntityHandler.isServerAuthorityHostileEntity(levelName, entityProps);

                if (isOwnedPlayer || isOwnedClientSpawn) {
                    levelMap.delete(entityId);
                    removedEntityIds.add(entityId);
                    removedEntityProps.set(entityId, entityProps);
                }
            }

            if (levelMap.size === 0) {
                GlobalState.levelEntities.delete(getClientLevelScope(client));
            }
        }

        if (client.playerSpawned && client.clientEntID > 0) {
            removedEntityIds.add(client.clientEntID);
        }

        for (const entityId of removedEntityIds) {
            EntityHandler.broadcastDestroyEntity(
                levelName,
                entityId,
                client,
                client.levelInstanceId,
                removedEntityProps.get(entityId)
            );
        }

        return Array.from(removedEntityIds);
    }

    private static sendExistingPlayersToJoiner(joiner: Client): void {
        for (const other of GlobalState.sessionsByToken.values()) {
            if (other === joiner) {
                continue;
            }
            if (!other.playerSpawned || !areClientsInSameLevelScope(joiner, other)) {
                continue;
            }
            if (other.userId && joiner.userId && other.userId === joiner.userId && other.character?.name === joiner.character?.name) {
                continue;
            }
            if (!other.character || other.clientEntID <= 0) {
                continue;
            }

            const otherProps = other.entities.get(other.clientEntID);
            if (!otherProps) {
                continue;
            }

            EntityHandler.sendEntity(joiner, Entity.fromCharacter(other.clientEntID, other.character, otherProps));
            EntityHandler.sendOtherPlayerMountToJoiner(joiner, other);
        }

        EntityHandler.replayStartedDungeonRoomEventsToJoiner(joiner);
        EntityHandler.scheduleExistingVisibleClientSpawnEntitiesToJoiner(joiner);
    }

    private static sendExistingVisibleClientSpawnEntitiesToJoiner(joiner: Client): void {
        if (!joiner.currentLevel) {
            return;
        }

        const levelMap = EntityHandler.getLevelMapForClient(joiner);
        if (!levelMap) {
            return;
        }

        for (const [entityId, entityProps] of levelMap.entries()) {
            if (entityId <= 0 || entityProps?.isPlayer || !entityProps?.clientSpawned) {
                continue;
            }
            if (EntityHandler.isEntityDead(entityProps)) {
                continue;
            }
            if (joiner.knownEntityIds.has(entityId)) {
                continue;
            }
            if (!EntityHandler.canClientSeeEntity(joiner, entityProps)) {
                continue;
            }
            if (EntityHandler.shouldDeferLiveSharedHostileSeedToJoiner(joiner, entityProps)) {
                continue;
            }

            const snapshot = EntityHandler.resolveCanonicalEntity(getClientLevelScope(joiner), entityId);
            if (!snapshot) {
                continue;
            }

            EntityHandler.sendEntity(joiner, snapshot);
        }
    }

    private static broadcastPlayerSpawn(client: Client, props: EntityProps): void {
        EntityHandler.refreshPlayerSnapshot(client);
    }

    static refreshPlayerSnapshot(client: Client, includeSelf: boolean = false): void {
        const playerEntity = EntityHandler.buildPlayerSnapshot(client);
        if (!playerEntity) {
            return;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if ((!includeSelf && other === client) || !other.playerSpawned || !areClientsInSameLevelScope(client, other)) {
                continue;
            }
            EntityHandler.sendEntity(other, playerEntity);
        }
    }

    private static broadcastToLevel(sender: Client, data: Buffer, entity: EntityProps): void {
        const myLevel = sender.currentLevel;
        const myScope = getClientLevelScope(sender);
        if (!myLevel || !myScope || !sender.playerSpawned) return;

        for (const other of GlobalState.sessionsByToken.values()) {
            if (other === sender || !other.playerSpawned || getClientLevelScope(other) !== myScope) {
                continue;
            }
            if (!entity.isPlayer && EntityHandler.isEntityDead(entity)) {
                continue;
            }
            if (!entity.isPlayer && !EntityHandler.canClientSeeEntity(other, entity)) {
                continue;
            }
            if (
                !entity.isPlayer &&
                EntityHandler.shouldDeferLiveSharedHostileSeedToJoiner(other, entity) &&
                !other.knownEntityIds.has(entity.id)
            ) {
                continue;
            }
            if (!EntityHandler.ensureEntityKnown(other, myLevel, entity.id)) {
                continue;
            }

            const localEntityId = EntityHandler.resolveEntityLocalId(other, entity.id);
            const outboundData = !entity.isPlayer && localEntityId !== entity.id
                ? EntityHandler.buildEntityFullUpdatePayload({
                    ...entity,
                    id: localEntityId
                })
                : data;
            other.send(0x8, outboundData);
        }
    }
}
