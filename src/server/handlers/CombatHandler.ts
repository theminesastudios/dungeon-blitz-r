import { Client, clearKeepTutorialTimers } from '../core/Client';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { BitReader } from '../network/protocol/bitReader';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import {
    noteDungeonRunCast,
    noteDungeonRunDeath,
    noteDungeonRunHit,
    noteDungeonRunKill
} from '../core/DungeonRunStats';
import { LevelHandler } from './LevelHandler';
import { EntityState, EntityTeam } from '../core/Entity';
import { EntityHandler } from './EntityHandler';
import { MissionHandler } from './MissionHandler';
import { areClientsInSameParty, getClientCharacterKey, sharesRoomIds, shouldShareCombatView } from '../core/PartySync';
import { areClientsInSameLevelScope, getClientLevelScope, getScopeLevelName } from '../core/LevelScope';
import {
    noteSharedDungeonHostileDestroyed,
    noteSharedDungeonHostileState,
    resolveSharedDungeonProgressAuthorityToken,
    usesSharedDungeonProgress
} from '../core/SharedDungeonProgress';
import { EquipmentHandler } from './EquipmentHandler';
import { GameData } from '../core/GameData';
import { CharacterSync } from '../utils/CharacterSync';
import { sendConsumableUpdate } from '../utils/ConsumableState';
import { LevelConfig } from '../core/LevelConfig';
import { isRoomBossEntity } from '../core/RoomBossState';
import { RewardHandler } from './RewardHandler';
import { TutorialDungeonMechanics } from '../core/TutorialDungeonMechanics';

type CombatRelayOptions = {
    includeAnchor?: boolean;
    referencedEntityIds?: number[];
};

type ContributionSnapshot = {
    nonce: number;
    contributors: string[];
};

type CombatPoint = {
    x: number;
    y: number;
};

type PowerCastRelayInfo = {
    sourceId: number;
    powerId: number;
    hasTargetEntity: boolean;
    hasTargetPos: boolean;
    targetPos: CombatPoint | null;
    projectileId: number | null;
    isPersistent: boolean;
    comboData: {
        isMelee: boolean;
        id: number;
    } | null;
};

type PowerHitRelayInfo = {
    targetId: number;
    sourceId: number;
    damage: number;
    powerId: number;
    animOverrideId: number | null;
    effectOverrideId: number | null;
    isCrit: boolean;
};

type BuffTickDotInfo = {
    targetId: number;
    sourceId: number;
    powerId: number;
    damage: number;
    rawDamage: number;
    tailBits: number;
};

type ServerAuthorityBuffSnapshot = {
    key: string;
    packetId: number;
    targetId: number;
    buffId: number;
    durationMs: number;
    expiresAt: number;
    sourceToken: number;
    sourceName: string;
    payloadHex: string;
    updatedAt: number;
};

type PlayerHitResolution = {
    appliedDamage: number;
    killed: boolean;
};

type NpcHitResolution = {
    entity: any | null;
    entityId?: number;
    appliedDamage?: number;
    killed: boolean;
};

type HostileViewerHealthSnapshot = {
    localId: number;
    previousHp: number;
    previousMaxHp: number;
};

export class CombatHandler {
    private static readonly MAX_RELAY_POWER_HIT_DAMAGE = 4_000_000;
    private static readonly FIREBRAND_THIRD_SHOT_POWER_ID = 6144;
    private static readonly FIREBRAND_PIERCING_SHOT_POWER_ID = 6146;
    private static readonly FIREBRAND_PIERCING_SHOT_RANGE = 800;
    private static readonly FIREBRAND_PIERCING_SHOT_MIN_HIT_RADIUS = 35;
    private static readonly FIREBRAND_PIERCING_HIT_DEDUPE_MS = 1_500;
    private static readonly FIREBRAND_THIRD_SHOT_HIT_DEDUPE_MS = 300;
    private static readonly SERVER_AUTHORITY_PROXY_HP_DEDUPE_MS = 500;
    private static readonly PARTY_SHARED_HOSTILE_HP_DEDUPE_MS = 500;
    private static readonly DEATH_EPSILON_HP = 1;
    private static readonly recentFireBrandThirdShotHits = new Map<string, number>();
    private static readonly recentFireBrandPiercingCasts = new Map<string, number>();
    private static readonly recentServerAuthorityProxyHpApplies = new Map<string, number>();
    private static readonly recentPartySharedHostileHpApplies = new Map<string, number>();
    private static readonly recentTutorialBossHitPackets = new Map<string, number>();
    private static readonly SERVER_AUTHORITY_SYNC_LEVELS = new Set<string>([
        'AC_Mission1',
        'JC_Mini1Hard',
        'TutorialDungeon'
    ]);

    private static clampRelayPowerHitDamage(damage: number): number {
        return Math.max(0, Math.min(CombatHandler.MAX_RELAY_POWER_HIT_DAMAGE, Math.round(Number(damage) || 0)));
    }

    private static tryConsumeRespawnPotion(client: Client): boolean {
        if (!client.character) {
            return false;
        }

        const nowMs = Date.now();
        const lastConsumeAtMs = Math.max(0, Number((client as any).lastRespawnPotionConsumeAtMs ?? 0));
        if (nowMs - lastConsumeAtMs <= 1_500) {
            return true;
        }

        const candidateIds = [
            Math.max(0, Math.round(Number(client.character.activeConsumableID ?? 0))),
            Math.max(0, Math.round(Number(client.character.queuedConsumableID ?? 0)))
        ];
        const consumables = Array.isArray(client.character.consumables) ? client.character.consumables : [];
        for (const entry of consumables) {
            const consumableId = Math.max(0, Math.round(Number(entry?.consumableID ?? 0)));
            if (!candidateIds.includes(consumableId)) {
                candidateIds.push(consumableId);
            }
        }

        for (const consumableId of candidateIds) {
            if (consumableId <= 0) {
                continue;
            }

            const def = GameData.CONSUMABLES.find((entry) => Number(entry?.ConsumableID ?? 0) === consumableId);
            if (String(def?.Type ?? '') !== 'ResPotion') {
                continue;
            }

            const entry = consumables.find((item: any) => Number(item?.consumableID ?? 0) === consumableId);
            const count = Math.max(0, Number(entry?.count ?? 0));
            if (!entry || count <= 0) {
                continue;
            }

            entry.count = count - 1;
            if (entry.count <= 0) {
                client.character.consumables = consumables.filter((item: any) => Number(item?.consumableID ?? 0) !== consumableId);
                if (Math.max(0, Math.round(Number(client.character.activeConsumableID ?? 0))) === consumableId) {
                    client.character.activeConsumableID = 0;
                }
                if (Math.max(0, Math.round(Number(client.character.queuedConsumableID ?? 0))) === consumableId) {
                    client.character.queuedConsumableID = 0;
                }
            }

            sendConsumableUpdate(client, consumableId);
            (client as any).lastRespawnPotionConsumeAtMs = nowMs;
            return true;
        }

        return false;
    }

    private static readonly PLAYER_OUT_OF_COMBAT_REGEN_DELAY_MS = 5_000;
    private static readonly PLAYER_OUT_OF_COMBAT_REGEN_INTERVAL_MS = 1_000;
    private static readonly PLAYER_REGEN_RATE = 0.05;
    private static readonly PLAYER_HP_LOG_THROTTLE_MS = 1_000;
    private static readonly BOSS_REGEN_LOG_THROTTLE_MS = 1_000;
    private static readonly ORIGINAL_REGEN_INTERVAL_MS = 1_000;
    private static readonly DUNGEON_BOSS_OUT_OF_COMBAT_REGEN_DELAY_MS = 500;
    private static readonly DUNGEON_BOSS_REGEN_INTERVAL_MS = CombatHandler.ORIGINAL_REGEN_INTERVAL_MS;
    private static readonly HOSTILE_REGEN_RATE = 0.01;
    private static readonly CLIENT_HEAL_PACKET_ID = 0x78;
    private static readonly BOSS_MELEE_AGGRO_RADIUS = 180;
    private static readonly BOSS_RANGED_AGGRO_RADIUS = 260;
    private static readonly KNOWN_ROOM_BOSS_DISPLAY_KEYS_BY_ENTITY = new Map<string, ReadonlySet<string>>([
        ['defectormage', new Set(['princefriedrichhocke', 'princefredrichhocke'])],
        ['defectormagehard', new Set(['princefriedrichhocke', 'princefredrichhocke'])],
        ['dreadpaladin', new Set(['dreadpaladinlothyr'])],
        ['dreadpaladin2', new Set(['dreadpaladinlothyr'])],
        ['dreadpaladin3', new Set(['dreadpaladinlothyr'])],
        ['dreadpaladin2hard', new Set(['dreadpaladinlothyr'])],
        ['dreadpaladin3hard', new Set(['dreadpaladinlothyr'])],
        ['dreadpaladinhard', new Set(['dreadpaladinlothyr'])]
    ]);
    private static readonly KNOWN_ROOM_BOSS_DISPLAY_KEYS_BY_LEVEL = new Map<string, ReadonlySet<string>>([
        ['JC_Mission1', new Set(['imperialchampion', 'imperialcommandergrahl'])],
        ['JC_Mission1Hard', new Set(['imperialchampionhard', 'imperialcommandergrahl', 'imperialcommandergrahlhard'])],
        ['JC_Mission3', new Set(['defectormage', 'princefriedrichhocke', 'princefredrichhocke'])],
        ['JC_Mission3Hard', new Set(['defectormagehard', 'princefriedrichhocke', 'princefredrichhocke'])]
    ]);
    private static readonly HOSTILE_BASE_HITPOINTS = [
        100, 4920, 5580, 6020, 6520, 7040, 7580, 8180, 8800, 9480, 10180, 10960, 11740, 12640, 13540, 14540,
        15560, 16660, 17860, 19120, 20440, 21860, 23360, 24960, 26680, 28460, 30380, 32420, 34580, 36900, 39320,
        41920, 44660, 47560, 50660, 53940, 57420, 61080, 64980, 69120, 73520, 78160, 83100, 88300, 93820, 99700,
        105880, 112460, 119400, 126760, 134560
    ] as const;
    // Extracted from Game.swz power metadata: these target methods require a real target entity on the client.
    private static readonly UNSAFE_REMOTE_DIRECT_TARGET_POWER_IDS = new Set<number>([
        39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
        362, 363, 781, 1447, 1448, 1525, 1526, 1527, 1528, 1529, 1530, 1531, 1532, 1533, 1534,
        1535, 1536, 1537, 1538, 1539, 1540, 1541, 1542, 1543, 1544, 1545, 1546, 1547, 1548,
        1549, 1550, 1551, 1552, 1553, 1554, 1555, 1556, 1557, 1558
    ]);
    private static readonly PLAYER_HITPOINTS = [
        100, 7400, 8031, 8369, 8724, 9095, 9485, 9893, 10321, 10770, 11240, 11733, 12249, 12791,
        13358, 13953, 14576, 15229, 15914, 16632, 17384, 18172, 18999, 19865, 20773, 21724,
        22722, 23767, 24862, 26011, 27214, 28476, 29798, 31184, 32636, 34159, 35755, 37427,
        39180, 41017, 42943, 44961, 47077, 49294, 51618, 54054, 56607, 59283, 62088, 65028,
        68109, 71338, 74723, 78271, 81989, 85887
    ] as const;
    private static readonly recentPlayerHpLogs = new Map<string, number>();
    private static readonly recentBossRegenLogs = new Map<string, number>();

    private static getEntityKey(levelName: string, entityId: number): string {
        return `${levelName}:${entityId}`;
    }

    private static getContributionKey(levelName: string, entityId: number, nonce: number): string {
        return `${levelName}:${entityId}:${nonce}`;
    }

    static getEntityLifeNonce(levelName: string, entityId: number): number {
        if (!levelName || entityId <= 0) {
            return 0;
        }

        return Number(GlobalState.entityLifeNonces.get(CombatHandler.getEntityKey(levelName, entityId)) ?? 0);
    }

    private static setEntityLifeNonce(levelName: string, entityId: number, nonce: number): void {
        if (!levelName || entityId <= 0) {
            return;
        }

        GlobalState.entityLifeNonces.set(CombatHandler.getEntityKey(levelName, entityId), Math.max(0, Math.floor(nonce)));
    }

    static noteEntityDestroyed(levelName: string, entityId: number): void {
        if (!levelName || entityId <= 0) {
            return;
        }

        const entityKey = CombatHandler.getEntityKey(levelName, entityId);
        const nonce = CombatHandler.getEntityLifeNonce(levelName, entityId);
        GlobalState.entityLastRewardNonces.set(entityKey, nonce);
        CombatHandler.setEntityLifeNonce(levelName, entityId, nonce + 1);
    }

    static clearEntityRewardTracking(levelName: string, entityId: number): void {
        if (!levelName || entityId <= 0) {
            return;
        }

        const entityKey = CombatHandler.getEntityKey(levelName, entityId);
        const currentNonce = CombatHandler.getEntityLifeNonce(levelName, entityId);
        GlobalState.combatContributions.delete(CombatHandler.getContributionKey(levelName, entityId, currentNonce));
        GlobalState.entityLastRewardNonces.delete(entityKey);
    }

    static getContributionSnapshot(levelName: string, entityId: number): ContributionSnapshot {
        const currentNonce = CombatHandler.getEntityLifeNonce(levelName, entityId);
        const currentKey = CombatHandler.getContributionKey(levelName, entityId, currentNonce);
        const currentContributors = GlobalState.combatContributions.get(currentKey);
        if (currentContributors && currentContributors.size > 0) {
            return {
                nonce: currentNonce,
                contributors: Array.from(currentContributors.keys())
            };
        }

        const lastNonce = GlobalState.entityLastRewardNonces.get(CombatHandler.getEntityKey(levelName, entityId));
        if (lastNonce !== undefined) {
            const lastKey = CombatHandler.getContributionKey(levelName, entityId, Number(lastNonce));
            const previousContributors = GlobalState.combatContributions.get(lastKey);
            if (previousContributors && previousContributors.size > 0) {
                return {
                    nonce: Number(lastNonce),
                    contributors: Array.from(previousContributors.keys())
                };
            }
        }

        return {
            nonce: currentNonce,
            contributors: []
        };
    }

    private static recordContribution(levelName: string, entityId: number, contributor: Client, damage: number): void {
        if (!levelName || entityId <= 0 || damage <= 0) {
            return;
        }

        const contributorKey = getClientCharacterKey(contributor);
        if (!contributorKey) {
            return;
        }

        const nonce = CombatHandler.getEntityLifeNonce(levelName, entityId);
        const key = CombatHandler.getContributionKey(levelName, entityId, nonce);
        let contributions = GlobalState.combatContributions.get(key);
        if (!contributions) {
            contributions = new Map<string, number>();
            GlobalState.combatContributions.set(key, contributions);
        }

        contributions.set(contributorKey, Number(contributions.get(contributorKey) ?? 0) + Math.max(0, Math.round(damage)));
    }

    private static getBaseHpForLevel(level: number): number {
        const maxIndex = CombatHandler.PLAYER_HITPOINTS.length - 1;
        const clampedLevel = Math.max(1, Math.min(maxIndex, Math.floor(Number(level) || 1)));
        return CombatHandler.PLAYER_HITPOINTS[clampedLevel];
    }

    private static getRespawnHealAmount(client: Client): number {
        const entity = client.clientEntID > 0 ? client.entities.get(client.clientEntID) : null;
        const levelEntity = client.clientEntID > 0
            ? CombatHandler.resolveLevelEntity(getClientLevelScope(client), client.clientEntID)
            : null;
        return CombatHandler.resolvePlayerMaxHp(client, entity, levelEntity);
    }

    private static hasFreshRespawnCombatStats(client: Client, nowMs: number): boolean {
        return !client.combatStatsDirty && nowMs - Math.max(0, client.lastCombatStatsSyncedAt) <= 1_000;
    }

    private static sendRespawnResponse(client: Client, usePotion: boolean): void {
        const healAmount = CombatHandler.getRespawnHealAmount(client);

        const bb = new BitBuffer(false);
        bb.writeMethod24(healAmount);
        bb.writeMethod15(usePotion);

        client.sendBitBuffer(0x80, bb);
    }

    private static deferRespawnResponseForCombatStats(client: Client, usePotion: boolean, nowMs: number): void {
        client.pendingRespawnRequest = { usePotion, requestedAt: nowMs };
        client.combatStatsDirty = true;
        client.allowDirtyCombatStatsRegen = false;
        client.lastCombatStatsRefreshRequestAt = nowMs;
        CharacterSync.requestCombatStatsRefresh(client);
    }

    static completePendingRespawnAfterCombatStats(client: Client): void {
        const pending = client.pendingRespawnRequest;
        if (!pending) {
            return;
        }

        client.pendingRespawnRequest = null;
        CombatHandler.sendRespawnResponse(client, pending.usePotion);
    }

    private static getHostileBaseHpForLevel(level: number): number {
        const maxIndex = CombatHandler.HOSTILE_BASE_HITPOINTS.length - 1;
        const clampedLevel = Math.max(1, Math.min(maxIndex, Math.floor(Number(level) || 1)));
        return CombatHandler.HOSTILE_BASE_HITPOINTS[clampedLevel];
    }

    private static getBestKnownPositiveValue(...values: number[]): number {
        let best = 0;
        for (const rawValue of values) {
            const value = Math.round(Number(rawValue));
            if (Number.isFinite(value) && value > best) {
                best = value;
            }
        }
        return best;
    }

    private static resolvePlayerMaxHp(client: Client, entity: any, levelEntity: any): number {
        const baseMaxHp = CombatHandler.getBaseHpForLevel(Number(client.character?.level ?? 1));
        const bestKnownMaxHp = CombatHandler.getBestKnownPositiveValue(
            Number(entity?.maxHp ?? 0),
            Number(levelEntity?.maxHp ?? 0),
            Number(client.authoritativeMaxHp ?? 0)
        );
        const bestKnownCurrentHp = CombatHandler.getBestKnownPositiveValue(
            Number(entity?.hp ?? 0),
            Number(levelEntity?.hp ?? 0),
            Number(client.authoritativeCurrentHp ?? 0)
        );
        if (bestKnownMaxHp > 100) {
            return Math.max(1, bestKnownMaxHp, bestKnownCurrentHp);
        }

        return Math.max(1, baseMaxHp, bestKnownCurrentHp);
    }

    private static resolvePlayerCurrentHp(client: Client, entity: any, levelEntity: any, maxHp: number): number {
        const authoritativeMaxHp = Math.round(Number(client.authoritativeMaxHp ?? 0));
        const authoritativeCurrentHp = Math.round(Number(client.authoritativeCurrentHp ?? NaN));
        const candidates: number[] = [];
        const addCandidate = (rawValue: unknown, trusted: boolean = true): void => {
            if (!trusted) {
                return;
            }
            const value = Math.round(Number(rawValue));
            if (Number.isFinite(value) && value > 0) {
                candidates.push(Math.max(0, Math.min(maxHp, value)));
            }
        };

        addCandidate(entity?.hp);
        addCandidate(levelEntity?.hp);
        addCandidate(
            authoritativeCurrentHp,
            CombatHandler.shouldTrustAuthoritativePlayerHp(client, authoritativeCurrentHp, authoritativeMaxHp)
        );

        const reducedCandidates = candidates.filter((hp) => hp > 0 && hp < maxHp);
        if (reducedCandidates.length > 0) {
            return Math.min(...reducedCandidates);
        }

        if (candidates.length > 0) {
            return Math.min(maxHp, Math.max(...candidates));
        }

        return maxHp;
    }

    private static shouldDeferPlayerRegenForCombatStats(client: Client, nowMs: number): boolean {
        if (!client.combatStatsDirty) {
            return false;
        }

        if (nowMs - Math.max(0, client.lastCombatStatsRefreshRequestAt) >= 1_000) {
            client.lastCombatStatsRefreshRequestAt = nowMs;
            CharacterSync.requestCombatStatsRefresh(client);
        }
        return !client.allowDirtyCombatStatsRegen;
    }

    private static shouldTrustAuthoritativePlayerHp(client: Client, authoritativeCurrentHp: number, authoritativeMaxHp: number): boolean {
        if (!Number.isFinite(authoritativeCurrentHp)) {
            return false;
        }

        if (authoritativeMaxHp > 100 || Math.max(0, client.lastCombatActivityAt) > 0) {
            return true;
        }

        return authoritativeMaxHp > 0 && authoritativeCurrentHp < authoritativeMaxHp;
    }

    private static normalizeCombatLookupKey(value: unknown): string {
        return String(value ?? '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '');
    }

    private static getKnownClientRoomBossLookupKeys(entity: any): string[] {
        const keys = [
            entity?.name,
            entity?.EntName,
            entity?.entName,
            entity?.roomBossName,
            entity?.displayName,
            entity?.DisplayName,
            entity?.characterName,
            entity?.character_name
        ]
            .map((value) => CombatHandler.normalizeCombatLookupKey(value))
            .filter((value) => value.length > 0);

        return [...new Set(keys)];
    }

    private static isKnownClientRoomBossEntity(levelName: string, entity: any): boolean {
        const entityKey = CombatHandler.normalizeCombatLookupKey(entity?.name ?? entity?.EntName ?? entity?.entName);
        const bossNameKey = CombatHandler.normalizeCombatLookupKey(
            entity?.roomBossName ?? entity?.displayName ?? entity?.DisplayName ?? entity?.characterName ?? entity?.character_name
        );
        if (entityKey && bossNameKey && CombatHandler.KNOWN_ROOM_BOSS_DISPLAY_KEYS_BY_ENTITY.get(entityKey)?.has(bossNameKey)) {
            return true;
        }

        const normalizedLevelName = LevelConfig.normalizeLevelName(levelName) || levelName;
        const knownLevelKeys = CombatHandler.KNOWN_ROOM_BOSS_DISPLAY_KEYS_BY_LEVEL.get(normalizedLevelName);
        return Boolean(knownLevelKeys && CombatHandler.getKnownClientRoomBossLookupKeys(entity).some((key) => knownLevelKeys.has(key)));
    }

    private static buildCharRegenPayload(entityId: number, amount: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(amount);
        return bb.toBuffer();
    }

    private static sendCharRegen(client: Client, entityId: number, amount: number): void {
        client.send(CombatHandler.CLIENT_HEAL_PACKET_ID, CombatHandler.buildCharRegenPayload(entityId, amount));
    }

    private static isTerminalHostileEntity(entity: any): boolean {
        const hp = Number(entity?.hp ?? NaN);
        const hasPositiveHp = Number.isFinite(hp) && Math.round(hp) > 0;
        return Boolean(entity) &&
            !Boolean(entity?.isPlayer) &&
            Number(entity?.team ?? 0) === EntityTeam.ENEMY &&
            (
                Boolean(entity?.destroyed) ||
                (Number.isFinite(hp) && Math.round(hp) <= 0) ||
                (!hasPositiveHp && (
                    Boolean(entity?.dead) ||
                    Number(entity?.entState ?? EntityState.ACTIVE) === EntityState.DEAD
                ))
            );
    }

    private static sendPostDeathSourceCorrection(
        client: Client,
        levelScope: string,
        canonicalEntity: any,
        rawLocalId: number,
        kind: string
    ): void {
        const canonicalId = Math.max(0, Math.round(Number(canonicalEntity?.id ?? 0)));
        const localId = Math.max(0, Math.round(Number(rawLocalId) || 0));
        if (canonicalId <= 0 || localId <= 0) {
            return;
        }

        CombatHandler.sendHostileDeathCorrectionToViewer(
            client,
            levelScope,
            canonicalEntity,
            localId,
            'dead_hostile_still_firing'
        );
    }

    private static incrementHostileHpVersion(entity: any): number {
        if (!entity || typeof entity !== 'object') {
            return 0;
        }

        entity.hpVersion = Math.max(0, Math.round(Number(entity.hpVersion ?? 0))) + 1;
        return entity.hpVersion;
    }

    private static isCanonicalHostileTerminal(levelScope: string, entity: any): boolean {
        if (!entity || typeof entity !== 'object') {
            return false;
        }

        return Boolean(entity.dead) ||
            Boolean(entity.destroyed) ||
            Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD ||
            Math.round(Number(entity.hp ?? 1)) <= 0 ||
            Boolean(EntityHandler.findDeadServerAuthorityHostileTombstone(levelScope, entity));
    }

    private static buildHpDeltaPayload(entityId: number, delta: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(delta);
        return bb.toBuffer();
    }

    private static buildEntityStatePayload(entityId: number, entState: number, facingLeft: boolean): Buffer {
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
        return bb.toBuffer();
    }

    private static buildEntityStatePayloadFromParts(
        entityId: number,
        x: number,
        y: number,
        v: number,
        entState: number,
        flags: boolean[]
    ): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(x);
        bb.writeMethod45(y);
        bb.writeMethod45(v);
        bb.writeMethod6(entState, 2);
        for (let i = 0; i < 6; i++) {
            bb.writeMethod15(Boolean(flags[i]));
        }
        return bb.toBuffer();
    }

    private static buildDestroyEntityPayload(entityId: number, immediate: boolean = true): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod15(immediate);
        return bb.toBuffer();
    }

    private static getEntityCombatActivityAt(entity: any): number {
        return Math.max(0, Math.round(Number(entity?.lastCombatActivityAt ?? 0)));
    }

    private static setEntityCombatActivity(entity: any, atMs: number): void {
        if (!entity || typeof entity !== 'object') {
            return;
        }

        entity.lastCombatActivityAt = Math.max(0, Math.round(atMs));
    }

    private static getEntityLastRegenTickAt(entity: any): number {
        return Math.max(0, Math.round(Number(entity?.lastCombatRegenTickAt ?? 0)));
    }

    private static setEntityLastRegenTickAt(entity: any, atMs: number): void {
        if (!entity || typeof entity !== 'object') {
            return;
        }

        entity.lastCombatRegenTickAt = Math.max(0, Math.round(atMs));
    }

    private static notePlayerDamageTakenActivity(client: Client, atMs: number): void {
        client.lastCombatActivityAt = Math.max(0, Math.round(atMs));
        client.lastCombatRegenTickAt = 0;
    }

    private static noteHostileCombatActivity(entity: any, atMs: number): void {
        CombatHandler.setEntityCombatActivity(entity, atMs);
        CombatHandler.setEntityLastRegenTickAt(entity, 0);
    }

    private static noteHostileAggroTarget(entity: any, targetSession: Client | null, atMs: number): void {
        if (!entity || typeof entity !== 'object' || !targetSession?.playerSpawned || targetSession.clientEntID <= 0) {
            return;
        }
        if (CombatHandler.isPlayerSessionDead(targetSession)) {
            return;
        }

        CombatHandler.noteHostileCombatActivity(entity, atMs);
        entity.aggroTargetEntityId = targetSession.clientEntID;
        entity.aggroTargetToken = targetSession.token;
    }

    private static getPendingRegenTicks(
        lastCombatActivityAt: number,
        lastRegenTickAt: number,
        nowMs: number,
        delayMs: number,
        intervalMs: number
    ): { ticks: number; baseTickAt: number } | null {
        if (lastCombatActivityAt <= 0) {
            return null;
        }

        const firstTickAt = lastRegenTickAt > 0
            ? lastRegenTickAt + intervalMs
            : lastCombatActivityAt + delayMs;
        const elapsedMs = nowMs - firstTickAt;
        if (elapsedMs < 0) {
            return null;
        }

        return {
            ticks: Math.floor(elapsedMs / intervalMs) + 1,
            baseTickAt: firstTickAt
        };
    }

    private static isPlayerSessionDead(client: Client): boolean {
        if (Math.round(Number(client.authoritativeCurrentHp ?? 1)) <= 0) {
            return true;
        }

        const localEntity = client.entities.get(client.clientEntID);
        const levelEntity = CombatHandler.resolveLevelEntity(getClientLevelScope(client), client.clientEntID);
        return CombatHandler.isEntityDead(localEntity) ||
            CombatHandler.isEntityDead(levelEntity);
    }

    private static hasLivingHostileAggroTarget(levelScope: string, entity: any): boolean {
        const aggroTargetEntityId = Math.max(0, Math.round(Number(entity?.aggroTargetEntityId ?? 0)));
        const aggroTargetToken = Math.max(0, Math.round(Number(entity?.aggroTargetToken ?? 0)));
        if (aggroTargetEntityId <= 0 && aggroTargetToken <= 0) {
            return false;
        }

        for (const session of GlobalState.sessionsByToken.values()) {
            if (!session.playerSpawned || getClientLevelScope(session) !== levelScope) {
                continue;
            }
            if (
                (aggroTargetEntityId > 0 && session.clientEntID === aggroTargetEntityId) ||
                (aggroTargetToken > 0 && session.token === aggroTargetToken)
            ) {
                if (CombatHandler.isPlayerSessionDead(session)) {
                    CombatHandler.clearHostileAggroTargetForPlayer(entity, session);
                    return false;
                }

                if (CombatHandler.isPlayerInBossAggro(levelScope, entity, session)) {
                    return true;
                }

                CombatHandler.clearHostileAggroTargetForPlayer(entity, session);
                return false;
            }
        }

        return false;
    }

    private static hasLivingPlayerInHostileRoom(levelScope: string, entity: any): boolean {
        const sourceRoomId = Number.isFinite(Number(entity?.roomId)) ? Math.round(Number(entity.roomId)) : -1;
        for (const session of GlobalState.sessionsByToken.values()) {
            if (!session.playerSpawned || getClientLevelScope(session) !== levelScope) {
                continue;
            }
            if (sourceRoomId >= 0 && !sharesRoomIds(session.currentRoomId, sourceRoomId)) {
                continue;
            }
            if (!CombatHandler.isPlayerSessionDead(session)) {
                return true;
            }
        }

        return false;
    }

    private static shouldSuppressHostileBossPower(levelScope: string, sourceEntity: any): boolean {
        if (
            !sourceEntity ||
            Boolean(sourceEntity.isPlayer) ||
            Number(sourceEntity.team ?? 0) !== EntityTeam.ENEMY ||
            !CombatHandler.isDungeonBossEntity(levelScope, sourceEntity)
        ) {
            return false;
        }

        return !CombatHandler.hasLivingPlayerInHostileRoom(levelScope, sourceEntity);
    }

    private static isEntityDead(entity: any): boolean {
        return Boolean(entity?.dead) ||
            Boolean(entity?.destroyed) ||
            Number(entity?.entState ?? EntityState.ACTIVE) === EntityState.DEAD;
    }

    private static isEntityActiveWithPositiveHp(entity: any): boolean {
        if (!entity || typeof entity !== 'object' || CombatHandler.isEntityDead(entity)) {
            return false;
        }

        const hp = Number(entity.hp ?? NaN);
        return Number.isFinite(hp) ? Math.round(hp) > 0 : true;
    }

    static isPlayerDeadForCombat(client: Client, levelScope: string = getClientLevelScope(client)): boolean {
        if (!client || typeof client !== 'object') {
            return true;
        }
        if (client.playerSpawned === false) {
            return true;
        }

        const entityId = Math.max(0, Math.round(Number(client.clientEntID ?? 0)));
        if (entityId <= 0) {
            return false;
        }

        const authoritativeHp = Number(client.authoritativeCurrentHp ?? NaN);
        if (Number.isFinite(authoritativeHp) && Math.round(authoritativeHp) <= 0) {
            return true;
        }

        const localEntity = typeof client.entities?.get === 'function'
            ? client.entities.get(entityId)
            : null;
        const levelEntity = levelScope
            ? CombatHandler.resolveLevelEntity(levelScope, entityId)
            : null;
        return CombatHandler.isEntityDead(localEntity) || CombatHandler.isEntityDead(levelEntity);
    }

    private static isDungeonBossEntity(levelScope: string, entity: any): boolean {
        const levelName = getScopeLevelName(levelScope);
        const markedRoomBoss = isRoomBossEntity(levelScope, entity);
        const isDungeonLevel = LevelConfig.isDungeonLevel(levelName);
        if (GameData.isDungeonBossEntity(levelName, entity)) {
            return true;
        }

        if (
            isDungeonLevel &&
            CombatHandler.isKnownClientRoomBossEntity(levelName, entity)
        ) {
            return true;
        }

        if (!isDungeonLevel) {
            return false;
        }

        const entityKey = CombatHandler.normalizeCombatLookupKey(entity?.name ?? entity?.EntName ?? entity?.entName);
        if (
            entityKey &&
            CombatHandler.KNOWN_ROOM_BOSS_DISPLAY_KEYS_BY_ENTITY.has(entityKey) &&
            !CombatHandler.isKnownClientRoomBossEntity(levelName, entity) &&
            !markedRoomBoss
        ) {
            return false;
        }

        if (String(GameData.getEntityRank(entity)).trim() === 'Boss') {
            return true;
        }

        return markedRoomBoss && GameData.isBossEntity(entity);
    }

    private static getKnownDungeonBossHomePosition(levelScope: string, entity: any): { x: number; y: number } | null {
        const levelName = getScopeLevelName(levelScope);
        const entityName = String(entity?.name ?? '');
        if (
            (levelName === 'JC_Mini2' && entityName === 'TowerGuard2') ||
            (levelName === 'JC_Mini2Hard' && entityName === 'TowerGuard2Hard')
        ) {
            return { x: 900, y: -20 };
        }

        return null;
    }

    private static getBossAggroRadius(entity: any): number {
        const entType = GameData.getEntType(String(entity?.name ?? '')) ?? {};
        return entType?.RangedPower
            ? CombatHandler.BOSS_RANGED_AGGRO_RADIUS
            : CombatHandler.BOSS_MELEE_AGGRO_RADIUS;
    }

    private static estimateHostileMaxHp(entity: any): number {
        const entType = GameData.getEntType(String(entity?.name ?? '')) ?? {};
        const rawLevel = Number(entity?.level ?? entType?.Level ?? entType?.baseLevel ?? entType?.ExpLevel ?? 1);
        const hitPointScale = Number(entity?.HitPoints ?? entity?.hitPoints ?? entType?.HitPoints ?? NaN);
        if (!Number.isFinite(hitPointScale) || hitPointScale <= 0) {
            return 0;
        }

        return Math.max(1, Math.round(CombatHandler.getHostileBaseHpForLevel(rawLevel) * hitPointScale));
    }

    private static getNpcHealthDelta(entity: any): number {
        const deltas = [entity?.healthDelta, entity?.health_delta]
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value))
            .map((value) => Math.round(value));
        return deltas.length > 0 ? Math.min(...deltas) : 0;
    }

    private static getNpcHealthState(entity: any): { maxHp: number; currentHp: number; authoritativeKill: boolean } | null {
        if (!entity || entity.isPlayer) {
            return null;
        }
        if (EntityHandler.isHomeDummyEntity(entity)) {
            const maxHp = Math.max(1, CombatHandler.estimateHostileMaxHp(entity));
            return {
                maxHp,
                currentHp: maxHp,
                authoritativeKill: false
            };
        }

        const explicitMaxHp = Math.max(0, Math.round(Number(entity.maxHp ?? 0)));
        const rawHp = Number(entity.hp ?? NaN);
        const estimatedMaxHp = CombatHandler.estimateHostileMaxHp(entity);
        const maxHp = explicitMaxHp > 0
            ? explicitMaxHp
            : estimatedMaxHp > 0
                ? estimatedMaxHp
                : (Number.isFinite(rawHp) ? Math.max(1, Math.round(rawHp)) : 0);
        if (maxHp <= 0) {
            return null;
        }

        const healthDelta = CombatHandler.getNpcHealthDelta(entity);
        const deltaHp = healthDelta < 0 ? maxHp + healthDelta : NaN;
        let currentHp = 0;
        if (Number.isFinite(rawHp) && Number.isFinite(deltaHp)) {
            currentHp = Math.min(Math.round(rawHp), Math.round(deltaHp));
        } else if (Number.isFinite(rawHp)) {
            currentHp = Math.round(rawHp);
        } else {
            currentHp = Number.isFinite(deltaHp) ? Math.round(deltaHp) : maxHp;
        }

        return {
            maxHp,
            currentHp: Math.max(0, Math.min(maxHp, currentHp)),
            authoritativeKill: !Boolean(entity.clientSpawned) || (explicitMaxHp > 0 && Number.isFinite(rawHp))
        };
    }

    private static getHostileIdentityKeys(entity: any): string[] {
        const keys = [
            entity?.name,
            entity?.EntName,
            entity?.entName,
            entity?.characterName,
            entity?.character_name,
            entity?.displayName,
            entity?.DisplayName,
            entity?.roomBossName
        ]
            .map((value) => CombatHandler.normalizeCombatLookupKey(value))
            .filter((value) => value.length > 0);

        return [...new Set(keys)];
    }

    private static isEquivalentHostileEntity(levelScope: string, sourceEntity: any, candidate: any): boolean {
        if (
            !levelScope ||
            !sourceEntity ||
            !candidate ||
            Boolean(sourceEntity.isPlayer) ||
            Boolean(candidate.isPlayer) ||
            Number(sourceEntity.team ?? 0) !== EntityTeam.ENEMY ||
            Number(candidate.team ?? 0) !== EntityTeam.ENEMY
        ) {
            return false;
        }

        const sourceId = Math.max(0, Math.round(Number(sourceEntity.id ?? 0)));
        const candidateId = Math.max(0, Math.round(Number(candidate.id ?? 0)));
        if (sourceId > 0 && sourceId === candidateId) {
            return true;
        }

        const sourceRoomId = Math.round(Number(sourceEntity.roomId ?? -1));
        const candidateRoomId = Math.round(Number(candidate.roomId ?? -1));
        if (sourceRoomId >= 0 && candidateRoomId >= 0 && sourceRoomId !== candidateRoomId) {
            return false;
        }

        const sourceDisplayKey = CombatHandler.normalizeCombatLookupKey(
            sourceEntity.roomBossName ?? sourceEntity.displayName ?? sourceEntity.DisplayName ?? sourceEntity.characterName ?? sourceEntity.character_name
        );
        const candidateDisplayKey = CombatHandler.normalizeCombatLookupKey(
            candidate.roomBossName ?? candidate.displayName ?? candidate.DisplayName ?? candidate.characterName ?? candidate.character_name
        );
        if (sourceDisplayKey && candidateDisplayKey && sourceDisplayKey !== candidateDisplayKey) {
            return false;
        }

        const sourceKeys = CombatHandler.getHostileIdentityKeys(sourceEntity);
        const candidateKeys = new Set(CombatHandler.getHostileIdentityKeys(candidate));
        return sourceKeys.some((key) => candidateKeys.has(key));
    }

    private static findEquivalentLevelHostile(levelScope: string, sourceEntity: any): any | null {
        if (!levelScope || !sourceEntity || Boolean(sourceEntity.isPlayer) || Number(sourceEntity.team ?? 0) !== EntityTeam.ENEMY) {
            return null;
        }

        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (!levelMap) {
            return null;
        }

        const sourceId = Math.max(0, Math.round(Number(sourceEntity.id ?? 0)));
        const sourceIsBoss = CombatHandler.isDungeonBossEntity(levelScope, sourceEntity);
        let bestMatch: any | null = null;
        let bestScore = -1;

        for (const candidate of levelMap.values()) {
            const candidateId = Math.max(0, Math.round(Number(candidate?.id ?? 0)));
            if (candidateId <= 0 || candidateId === sourceId) {
                continue;
            }
            if (!CombatHandler.isEquivalentHostileEntity(levelScope, sourceEntity, candidate)) {
                continue;
            }

            const candidateIsBoss = CombatHandler.isDungeonBossEntity(levelScope, candidate);
            if (!sourceIsBoss && !candidateIsBoss) {
                continue;
            }

            const sourceX = Number(sourceEntity.x ?? NaN);
            const sourceY = Number(sourceEntity.y ?? NaN);
            const candidateX = Number(candidate.x ?? NaN);
            const candidateY = Number(candidate.y ?? NaN);
            const hasPositions = Number.isFinite(sourceX) && Number.isFinite(sourceY) && Number.isFinite(candidateX) && Number.isFinite(candidateY);
            const distanceScore = hasPositions
                ? Math.max(0, 10_000 - Math.round(((sourceX - candidateX) ** 2) + ((sourceY - candidateY) ** 2)))
                : 0;
            const score = (candidateIsBoss ? 100_000 : 0) + distanceScore;
            if (score > bestScore) {
                bestScore = score;
                bestMatch = candidate;
            }
        }

        return bestMatch;
    }

    private static resolveClientHostileEntityAlias(client: Client, levelScope: string, entityId: number): number {
        const localId = Math.max(0, Math.round(Number(entityId) || 0));
        if (
            !levelScope ||
            localId <= 0 ||
            localId === Math.max(0, Math.round(Number(client?.clientEntID ?? 0))) ||
            CombatHandler.resolveLevelEntity(levelScope, localId)
        ) {
            return localId;
        }

        const localEntity = client.entities.get(localId);
        if (localEntity && (Boolean(localEntity?.isPlayer) || Number(localEntity?.team ?? 0) !== EntityTeam.ENEMY)) {
            return localId;
        }

        const explicitCanonicalId = Math.max(
            0,
            Math.round(Number(localEntity?.canonicalEntityId ?? localEntity?.sharedCanonicalId ?? 0))
        );
        if (explicitCanonicalId > 0 && CombatHandler.resolveLevelEntity(levelScope, explicitCanonicalId)) {
            EntityHandler.rememberEntityAlias(client, localId, explicitCanonicalId);
            return explicitCanonicalId;
        }

        const canonicalEntity = CombatHandler.findEquivalentLevelHostile(levelScope, localEntity);
        const canonicalId = Math.max(0, Math.round(Number(canonicalEntity?.id ?? 0)));
        if (canonicalId > 0) {
            EntityHandler.rememberEntityAlias(client, localId, canonicalId);
            return canonicalId;
        }

        const roomBoss = CombatHandler.findSingleRoomBossForUnknownClientHostile(client, levelScope);
        const roomBossId = Math.max(0, Math.round(Number(roomBoss?.id ?? 0)));
        if (roomBossId > 0) {
            EntityHandler.rememberEntityAlias(client, localId, roomBossId);
            return roomBossId;
        }

        return localId;
    }

    static resolveClientHostileAliasForSharedState(client: Client, levelScope: string, entityId: number): number {
        return CombatHandler.resolveClientHostileEntityAlias(client, levelScope, entityId);
    }

    private static findSingleRoomBossForUnknownClientHostile(client: Client, levelScope: string): any | null {
        if (!levelScope) {
            return null;
        }

        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (!levelMap) {
            return null;
        }

        const clientRoomId = Math.round(Number(client?.currentRoomId ?? -1));
        const candidates: any[] = [];
        const seenIds = new Set<number>();
        for (const entity of levelMap.values()) {
            const entityId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
            if (
                entityId <= 0 ||
                seenIds.has(entityId) ||
                Boolean(entity?.isPlayer) ||
                Number(entity?.team ?? 0) !== EntityTeam.ENEMY ||
                !CombatHandler.isDungeonBossEntity(levelScope, entity)
            ) {
                continue;
            }

            const entityRoomId = Math.round(Number(entity?.roomId ?? -1));
            if (clientRoomId >= 0 && entityRoomId >= 0 && !sharesRoomIds(clientRoomId, entityRoomId)) {
                continue;
            }

            seenIds.add(entityId);
            candidates.push(entity);
        }

        return candidates.length === 1 ? candidates[0] : null;
    }

    private static collectHostileHealthCopies(levelScope: string, entity: any, includeEquivalent: boolean = false): any[] {
        const entityId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        if (!levelScope || entityId <= 0) {
            return [];
        }

        const copies: any[] = [];
        const add = (candidate: any, ownerSession: Client | null = null): void => {
            if (
                !candidate ||
                typeof candidate !== 'object' ||
                Boolean(candidate.isPlayer) ||
                (
                    Math.max(0, Math.round(Number(candidate.id ?? 0))) !== entityId &&
                    (!includeEquivalent || !CombatHandler.isEquivalentHostileEntity(levelScope, entity, candidate))
                )
            ) {
                return;
            }
            const candidateId = Math.max(0, Math.round(Number(candidate.id ?? 0)));
            if (ownerSession && candidateId > 0 && candidateId !== entityId) {
                EntityHandler.rememberEntityAlias(ownerSession, candidateId, entityId);
            }
            if (!copies.includes(candidate)) {
                copies.push(candidate);
            }
        };

        add(entity);
        add(GlobalState.levelEntities.get(levelScope)?.get(entityId));
        for (const session of GlobalState.sessionsByToken.values()) {
            if (getClientLevelScope(session) !== levelScope) {
                continue;
            }
            add(session.entities.get(entityId), session);
            if (includeEquivalent) {
                for (const candidate of session.entities.values()) {
                    add(candidate, session);
                }
            }
        }

        return copies;
    }

    private static isSessionPresentForHostileRegen(session: Client, levelScope: string): boolean {
        if (!session?.character || !levelScope || getClientLevelScope(session) !== levelScope) {
            return false;
        }
        if (session.playerSpawned) {
            return true;
        }

        return Boolean(session.enemyDeathRegenArmed) &&
            Math.max(0, Math.round(Number(session.clientEntID ?? 0))) > 0 &&
            Boolean(session.currentLevel);
    }

    static hasOutOfCombatRegenPresence(levelScope: string): boolean {
        if (!levelScope) {
            return false;
        }

        for (const session of GlobalState.sessionsByToken.values()) {
            if (CombatHandler.isSessionPresentForHostileRegen(session, levelScope)) {
                return true;
            }
        }

        return false;
    }

    private static getDeathRegenArmKeyForPlayer(client: Client): string {
        return `${client.token}:${client.clientEntID}`;
    }

    private static getHostileDeathRegenArmKey(entity: any): string {
        return String(entity?.deathRegenArmedForPlayerKey ?? '').trim();
    }

    private static isHostileDeathRegenArmed(entity: any): boolean {
        return CombatHandler.getHostileDeathRegenArmKey(entity).length > 0;
    }

    private static isHostileDefeatVerified(levelScope: string, entity: any): boolean {
        return CombatHandler.collectHostileHealthCopies(levelScope, entity, true)
            .some((copy) => Boolean(copy?.clientDefeatVerified));
    }

    private static getDeadPlayerForHostileDeathRegen(levelScope: string, entity: any): Client | null {
        const armKey = CombatHandler.getHostileDeathRegenArmKey(entity);
        if (!armKey) {
            return null;
        }

        for (const session of GlobalState.sessionsByToken.values()) {
            if (!session?.character || getClientLevelScope(session) !== levelScope) {
                continue;
            }
            if (CombatHandler.getDeathRegenArmKeyForPlayer(session) !== armKey) {
                continue;
            }
            if (!CombatHandler.isPlayerDeadForCombat(session, levelScope)) {
                return null;
            }

            return session;
        }

        return null;
    }

    private static isDeathArmedViewerForHostile(viewer: Client, entity: any): boolean {
        return Boolean(viewer?.enemyDeathRegenArmed) &&
            CombatHandler.getHostileDeathRegenArmKey(entity) === CombatHandler.getDeathRegenArmKeyForPlayer(viewer) &&
            CombatHandler.isPlayerDeadForCombat(viewer);
    }

    private static setHostileDeathRegenArm(levelScope: string, entity: any, armKey: string): void {
        for (const copy of CombatHandler.collectHostileHealthCopies(levelScope, entity, true)) {
            copy.deathRegenArmedForPlayerKey = armKey;
        }
    }

    private static clearHostileDeathRegenArm(levelScope: string, entity: any, armKey: string): void {
        if (!armKey) {
            return;
        }

        for (const copy of CombatHandler.collectHostileHealthCopies(levelScope, entity, true)) {
            if (CombatHandler.getHostileDeathRegenArmKey(copy) === armKey) {
                delete copy.deathRegenArmedForPlayerKey;
            }
        }
    }

    private static resolveHostileHealthStateAcrossCopies(
        levelScope: string,
        entity: any
    ): { maxHp: number; currentHp: number; authoritativeKill: boolean } | null {
        const states = CombatHandler.collectHostileHealthCopies(
            levelScope,
            entity,
            CombatHandler.isDungeonBossEntity(levelScope, entity)
        )
            .map((copy) => CombatHandler.getNpcHealthState(copy))
            .filter((state): state is { maxHp: number; currentHp: number; authoritativeKill: boolean } => Boolean(state));
        if (states.length <= 0) {
            return CombatHandler.getNpcHealthState(entity);
        }

        const maxHp = Math.max(...states.map((state) => state.maxHp), 1);
        const normalizedCurrents = states
            .map((state) => Math.max(0, Math.min(maxHp, Math.round(Number(state.currentHp) || 0))));
        const damagedCurrents = normalizedCurrents.filter((hp) => hp > 0 && hp < maxHp);
        const currentHp = damagedCurrents.length > 0
            ? Math.min(...damagedCurrents)
            : Math.min(maxHp, Math.max(...normalizedCurrents));

        return {
            maxHp,
            currentHp,
            authoritativeKill: states.some((state) => state.authoritativeKill)
        };
    }

    private static applyNpcHealthState(entity: any, maxHp: number, currentHp: number, authoritativeKill: boolean): number {
        if (!entity || typeof entity !== 'object') {
            return 0;
        }

        const normalizedHp = authoritativeKill
            ? Math.max(0, Math.min(maxHp, Math.round(currentHp)))
            : Math.max(1, Math.min(maxHp, Math.round(currentHp)));
        const healthDelta = normalizedHp - maxHp;

        entity.maxHp = maxHp;
        entity.hp = normalizedHp;
        entity.healthDelta = healthDelta;
        entity.health_delta = healthDelta;
        entity.dead = authoritativeKill ? normalizedHp <= 0 : false;
        if (entity.dead) {
            entity.entState = EntityState.DEAD;
        } else if (Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
            entity.entState = EntityState.ACTIVE;
        }

        return normalizedHp;
    }

    private static assignPartySharedHostileCombatAuthority(levelScope: string, entity: any, authority: Client | null): void {
        if (
            !levelScope ||
            !entity ||
            typeof entity !== 'object' ||
            !authority?.playerSpawned ||
            !CombatHandler.shouldMirrorClientSpawnEntityToParty(getScopeLevelName(levelScope), entity)
        ) {
            return;
        }

        const existingToken = Math.max(
            0,
            Math.round(Number(entity.combatAuthorityToken ?? entity.firstCombatAuthorityToken ?? 0) || 0)
        );
        const authorityToken = existingToken > 0 ? existingToken : Math.max(0, Math.round(Number(authority.token) || 0));
        if (authorityToken <= 0) {
            return;
        }

        const authoritySession = GlobalState.sessionsByToken.get(authorityToken) ?? authority;
        const authorityName = String(authoritySession.character?.name ?? entity.combatAuthorityName ?? entity.firstCombatAuthorityName ?? '');
        const startedAt = Math.max(
            1,
            Math.round(Number(entity.combatAuthorityStartedAt ?? entity.firstCombatAuthorityStartedAt ?? Date.now()) || Date.now())
        );

        const apply = (copy: any): void => {
            if (!copy || typeof copy !== 'object' || Boolean(copy.isPlayer) || Number(copy.team ?? 0) !== EntityTeam.ENEMY) {
                return;
            }
            copy.combatAuthorityToken = authorityToken;
            copy.firstCombatAuthorityToken = authorityToken;
            copy.combatAuthorityName = authorityName;
            copy.firstCombatAuthorityName = authorityName;
            copy.combatAuthorityStartedAt = startedAt;
            copy.firstCombatAuthorityStartedAt = startedAt;
        };

        apply(entity);
        for (const copy of CombatHandler.collectHostileHealthCopies(levelScope, entity, true)) {
            apply(copy);
        }
    }

    private static getPartySharedHostileCombatAuthorityToken(levelScope: string, entity: any): number {
        if (
            !levelScope ||
            !entity ||
            typeof entity !== 'object' ||
            Boolean(entity.isPlayer) ||
            Number(entity.team ?? 0) !== EntityTeam.ENEMY ||
            !CombatHandler.shouldMirrorClientSpawnEntityToParty(getScopeLevelName(levelScope), entity)
        ) {
            return 0;
        }

        return Math.max(
            0,
            Math.round(Number(entity.combatAuthorityToken ?? entity.firstCombatAuthorityToken ?? 0) || 0)
        );
    }

    private static getPartySharedHostileAiAuthorityToken(levelScope: string, entity: any): number {
        if (
            !levelScope ||
            !entity ||
            typeof entity !== 'object' ||
            Boolean(entity.isPlayer) ||
            Number(entity.team ?? 0) !== EntityTeam.ENEMY ||
            !CombatHandler.shouldMirrorClientSpawnEntityToParty(getScopeLevelName(levelScope), entity)
        ) {
            return 0;
        }

        return Math.max(
            0,
            Math.round(Number(entity.aiOwnerToken ?? entity.ownerToken ?? entity.proxyOwnerToken ?? 0) || 0)
        );
    }

    private static shouldSuppressNonAuthorityPartySharedHostileAction(
        client: Client,
        levelScope: string,
        entity: any
    ): boolean {
        const aiAuthorityToken = CombatHandler.getPartySharedHostileAiAuthorityToken(levelScope, entity);
        const authorityToken = aiAuthorityToken > 0
            ? aiAuthorityToken
            : CombatHandler.getPartySharedHostileCombatAuthorityToken(levelScope, entity);
        const suppress = authorityToken > 0 && authorityToken !== client.token;
        if (suppress) {
        }
        return suppress;
    }

    private static isDeadPartySharedHostile(levelScope: string, entity: any): boolean {
        if (
            !levelScope ||
            !entity ||
            Boolean(entity.isPlayer) ||
            Number(entity.team ?? 0) !== EntityTeam.ENEMY ||
            !CombatHandler.shouldMirrorClientSpawnEntityToParty(getScopeLevelName(levelScope), entity)
        ) {
            return false;
        }

        return CombatHandler.isEntityDead(entity) || Math.round(Number(entity.hp ?? 0)) <= 0;
    }

    private static shouldSuppressDeadPartySharedHostileAction(
        client: Client,
        levelScope: string,
        sourceEntity: any,
        reason: string
    ): boolean {
        if (!CombatHandler.isDeadPartySharedHostile(levelScope, sourceEntity)) {
            return false;
        }

        const canonicalId = Math.max(0, Math.round(Number(sourceEntity?.id ?? 0)));
        if (canonicalId > 0) {
            CombatHandler.relayPartyLocalEntityDefeat(
                client,
                levelScope,
                canonicalId,
                sourceEntity,
                { requireKnownOrLocal: false, sendHpCorrection: false, includeAnchor: true }
            );
        }
        return true;
    }

    private static shouldDeferPowerHitKillToClient(levelScope: string, entity: any): boolean {
        const levelName = getScopeLevelName(levelScope);
        return Boolean(
            levelName &&
            (
                DungeonCompletionConditions.isClientAuthorityBoss(levelName, entity) ||
                (
                    Boolean(entity?.clientSpawned) &&
                    DungeonCompletionConditions.isRequiredBoss(levelName, entity) &&
                    CombatHandler.isKnownClientRoomBossEntity(levelName, entity)
                )
            )
        );
    }

    private static noteCombatInteraction(levelScope: string, sourceId: number, targetId: number, fallbackClient: Client, atMs: number = Date.now()): void {
        if (!levelScope || sourceId <= 0 || targetId <= 0) {
            return;
        }

        const sourceEntity = CombatHandler.resolveLevelEntity(levelScope, sourceId);
        const targetEntity = CombatHandler.resolveLevelEntity(levelScope, targetId);
        const sourceSession = CombatHandler.resolveCombatSourceSession(levelScope, sourceId, fallbackClient);
        const targetSession = CombatHandler.findPlayerSessionByEntityId(targetId);
        const hostileSource = sourceEntity && !sourceEntity.isPlayer && Number(sourceEntity.team ?? 0) === EntityTeam.ENEMY
            ? sourceEntity
            : null;
        const hostileTarget = targetEntity && !targetEntity.isPlayer && Number(targetEntity.team ?? 0) === EntityTeam.ENEMY
            ? targetEntity
            : null;

        if (targetSession && hostileSource && getClientLevelScope(targetSession) === levelScope) {
            CombatHandler.notePlayerDamageTakenActivity(targetSession, atMs);
        }
        if (hostileSource) {
            CombatHandler.noteHostileAggroTarget(hostileSource, targetSession, atMs);
        }
        if (hostileTarget) {
            CombatHandler.noteHostileAggroTarget(hostileTarget, sourceSession, atMs);
        }
    }

    private static processPlayerOutOfCombatRegen(client: Client, nowMs: number): void {
        if (!client.playerSpawned || !client.character || client.clientEntID <= 0) {
            return;
        }

        const levelScope = getClientLevelScope(client);
        if (!levelScope) {
            return;
        }
        if (CombatHandler.shouldDeferPlayerRegenForCombatStats(client, nowMs)) {
            return;
        }

        const entity = client.entities.get(client.clientEntID) ??
            CombatHandler.resolveLevelEntity(levelScope, client.clientEntID);
        const levelEntity = CombatHandler.resolveLevelEntity(levelScope, client.clientEntID);
        if (CombatHandler.isEntityDead(entity) || CombatHandler.isEntityDead(levelEntity)) {
            return;
        }

        const maxHp = CombatHandler.resolvePlayerMaxHp(client, entity, levelEntity);
        const currentHp = CombatHandler.resolvePlayerCurrentHp(client, entity, levelEntity, maxHp);
        if (currentHp <= 0 || currentHp >= maxHp) {
            if (currentHp < maxHp) {
            }
            return;
        }

        if (Math.max(0, client.lastCombatActivityAt) <= 0) {
            client.lastCombatActivityAt = Math.max(0, nowMs - CombatHandler.PLAYER_OUT_OF_COMBAT_REGEN_DELAY_MS);
            client.lastCombatRegenTickAt = 0;
            return;
        }

        const regenState = CombatHandler.getPendingRegenTicks(
            Math.max(0, client.lastCombatActivityAt),
            Math.max(0, client.lastCombatRegenTickAt),
            nowMs,
            CombatHandler.PLAYER_OUT_OF_COMBAT_REGEN_DELAY_MS,
            CombatHandler.PLAYER_OUT_OF_COMBAT_REGEN_INTERVAL_MS
        );
        if (!regenState) {
            return;
        }

        const healPerTick = Math.max(1, Math.round(maxHp * CombatHandler.PLAYER_REGEN_RATE));
        const healAmount = Math.min(maxHp - currentHp, healPerTick * regenState.ticks);
        if (healAmount <= 0) {
            return;
        }

        const nextHp = currentHp + healAmount;
        if (entity && typeof entity === 'object') {
            entity.maxHp = maxHp;
            entity.hp = nextHp;
            entity.dead = false;
            if (Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
                entity.entState = EntityState.ACTIVE;
            }
        }

        if (levelEntity && typeof levelEntity === 'object') {
            levelEntity.maxHp = maxHp;
            levelEntity.hp = nextHp;
            levelEntity.dead = false;
            if (Number(levelEntity.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
                levelEntity.entState = EntityState.ACTIVE;
            }
        }

        client.authoritativeMaxHp = maxHp;
        client.authoritativeCurrentHp = nextHp;
        client.lastCombatRegenTickAt = regenState.baseTickAt +
            ((regenState.ticks - 1) * CombatHandler.PLAYER_OUT_OF_COMBAT_REGEN_INTERVAL_MS);

        const payload = CombatHandler.buildCharRegenPayload(client.clientEntID, healAmount);
        client.send(CombatHandler.CLIENT_HEAL_PACKET_ID, payload);
        CombatHandler.broadcastToSameLevel(levelScope, CombatHandler.CLIENT_HEAL_PACKET_ID, payload, [client.clientEntID], client);
    }

    private static processHostileOutOfCombatRegen(levelScope: string, entity: any, nowMs: number): void {
        if (!entity || entity.isPlayer || Number(entity.team ?? 0) !== EntityTeam.ENEMY) {
            return;
        }
        if (!CombatHandler.isDungeonBossEntity(levelScope, entity)) {
            return;
        }

        const healthState = CombatHandler.resolveHostileHealthStateAcrossCopies(levelScope, entity);
        const deathRegenArmKey = CombatHandler.getHostileDeathRegenArmKey(entity);
        const deathRegenArmed = deathRegenArmKey.length > 0;
        const deadDeathRegenPlayer = deathRegenArmed
            ? CombatHandler.getDeadPlayerForHostileDeathRegen(levelScope, entity)
            : null;
        const zeroHpOrDead = Boolean(healthState) &&
            (CombatHandler.isEntityDead(entity) || healthState!.currentHp <= 0);
        const verifiedDefeat = deathRegenArmed &&
            CombatHandler.isHostileDefeatVerified(levelScope, entity);
        if (
            !healthState ||
            healthState.currentHp >= healthState.maxHp ||
            (zeroHpOrDead && (!deadDeathRegenPlayer || verifiedDefeat))
        ) {
            return;
        }

        if (deathRegenArmed && !deadDeathRegenPlayer) {
            CombatHandler.clearHostileDeathRegenArm(levelScope, entity, deathRegenArmKey);
            return;
        }

        if (CombatHandler.hasLivingHostileAggroTarget(levelScope, entity)) {
            return;
        }

        if (CombatHandler.hasLivePlayerInBossAggro(levelScope, entity)) {
            CombatHandler.noteHostileCombatActivity(entity, nowMs);
            return;
        }

        if (!deathRegenArmed) {
            return;
        }

        const regenState = CombatHandler.getPendingRegenTicks(
            CombatHandler.getEntityCombatActivityAt(entity),
            CombatHandler.getEntityLastRegenTickAt(entity),
            nowMs,
            CombatHandler.DUNGEON_BOSS_OUT_OF_COMBAT_REGEN_DELAY_MS,
            CombatHandler.DUNGEON_BOSS_REGEN_INTERVAL_MS
        );
        if (!regenState) {
            return;
        }

        const healPerTick = Math.max(1, Math.round(CombatHandler.HOSTILE_REGEN_RATE * healthState.maxHp));
        const requestedHeal = Math.min(healthState.maxHp - healthState.currentHp, healPerTick * regenState.ticks);
        if (requestedHeal <= 0) {
            return;
        }

        const nextHp = CombatHandler.applyNpcHealthState(
            entity,
            healthState.maxHp,
            healthState.currentHp + requestedHeal,
            healthState.authoritativeKill
        );
        const actualHeal = nextHp - healthState.currentHp;
        if (actualHeal <= 0) {
            return;
        }

        CombatHandler.setEntityLastRegenTickAt(
            entity,
            regenState.baseTickAt + ((regenState.ticks - 1) * CombatHandler.DUNGEON_BOSS_REGEN_INTERVAL_MS)
        );
        CombatHandler.syncHostileHealthCopies(levelScope, entity, nextHp, healthState.maxHp);

        const payload = CombatHandler.buildCharRegenPayload(Number(entity.id ?? 0), actualHeal);
        const viewers = CombatHandler.broadcastHostileRegenPacket(levelScope, entity, payload);
    }

    private static broadcastHostileRegenPacket(levelScope: string, entity: any, payload: Buffer): number {
        if (!levelScope) {
            return 0;
        }

        const entityId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        if (entityId <= 0) {
            return 0;
        }

        let viewers = 0;
        const sourceRoomId = Number.isFinite(Number(entity?.roomId)) ? Number(entity.roomId) : -1;
        for (const viewer of GlobalState.sessionsByToken.values()) {
            if (!CombatHandler.isSessionPresentForHostileRegen(viewer, levelScope)) {
                continue;
            }
            const isDeathArmedViewer = CombatHandler.isDeathArmedViewerForHostile(viewer, entity);
            if (!isDeathArmedViewer && sourceRoomId >= 0 && !sharesRoomIds(viewer.currentRoomId, sourceRoomId)) {
                continue;
            }

            const canResolveEntity =
                isDeathArmedViewer ||
                CombatHandler.canViewerResolveCombatEntity(viewer, levelScope, entityId) ||
                viewer.entities.has(entityId) ||
                viewer.knownEntityIds.has(entityId);
            if (!canResolveEntity) {
                continue;
            }

            if (CombatHandler.sendTranslatedPacket(viewer, CombatHandler.CLIENT_HEAL_PACKET_ID, payload)) {
                viewers++;
            }
        }

        return viewers;
    }

    private static syncHostileHealthCopies(levelScope: string, sourceEntity: any, currentHp: number, maxHp: number): void {
        const entityId = Math.max(0, Math.round(Number(sourceEntity?.id ?? 0)));
        if (!levelScope || entityId <= 0) {
            return;
        }

        const normalizedMaxHp = Math.max(1, Math.round(Number(maxHp) || 1));
        const normalizedCurrentHp = Math.max(0, Math.min(normalizedMaxHp, Math.round(Number(currentHp) || 0)));
        const healthDelta = normalizedCurrentHp - normalizedMaxHp;
        const shouldSyncEquivalentCopies =
            CombatHandler.isDungeonBossEntity(levelScope, sourceEntity) ||
            CombatHandler.shouldMirrorClientSpawnEntityToParty(getScopeLevelName(levelScope), sourceEntity);
        const apply = (entity: any): void => {
            if (
                !entity ||
                typeof entity !== 'object' ||
                entity.isPlayer ||
                (
                    Number(entity.id ?? 0) !== entityId &&
                    !CombatHandler.isEquivalentHostileEntity(levelScope, sourceEntity, entity)
                )
            ) {
                return;
            }
            entity.maxHp = normalizedMaxHp;
            entity.hp = normalizedCurrentHp;
            entity.healthDelta = healthDelta;
            entity.health_delta = healthDelta;
            entity.hpVersion = Math.max(
                Math.max(0, Math.round(Number(entity.hpVersion ?? 0))),
                Math.max(0, Math.round(Number(sourceEntity.hpVersion ?? 0)))
            );
            if (sourceEntity.combatAuthorityToken || sourceEntity.firstCombatAuthorityToken) {
                entity.combatAuthorityToken = sourceEntity.combatAuthorityToken ?? sourceEntity.firstCombatAuthorityToken;
                entity.firstCombatAuthorityToken = sourceEntity.firstCombatAuthorityToken ?? sourceEntity.combatAuthorityToken;
                entity.combatAuthorityName = sourceEntity.combatAuthorityName ?? sourceEntity.firstCombatAuthorityName;
                entity.firstCombatAuthorityName = sourceEntity.firstCombatAuthorityName ?? sourceEntity.combatAuthorityName;
                entity.combatAuthorityStartedAt = sourceEntity.combatAuthorityStartedAt ?? sourceEntity.firstCombatAuthorityStartedAt;
                entity.firstCombatAuthorityStartedAt = sourceEntity.firstCombatAuthorityStartedAt ?? sourceEntity.combatAuthorityStartedAt;
            }
            if (normalizedCurrentHp <= 0) {
                entity.entState = EntityState.DEAD;
                entity.dead = true;
            } else if (Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
                entity.entState = EntityState.ACTIVE;
                entity.dead = false;
            } else if (Boolean(entity.dead)) {
                entity.dead = false;
            }
        };

        apply(GlobalState.levelEntities.get(levelScope)?.get(entityId));
        if (shouldSyncEquivalentCopies) {
            for (const copy of CombatHandler.collectHostileHealthCopies(levelScope, sourceEntity, true)) {
                apply(copy);
            }
            return;
        }

        for (const session of GlobalState.sessionsByToken.values()) {
            if (getClientLevelScope(session) !== levelScope) {
                continue;
            }
            apply(session.entities.get(entityId));
        }
    }

    private static collectHostileRegenCandidates(levelScope: string): any[] {
        const candidates: any[] = [];
        const seenIds = new Set<number>();
        const add = (entity: any, ownerSession: Client | null = null): void => {
            const entityId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
            if (entityId <= 0) {
                return;
            }

            const canonicalId = ownerSession
                ? CombatHandler.resolveClientHostileEntityAlias(ownerSession, levelScope, entityId)
                : entityId;
            const candidate = canonicalId !== entityId
                ? CombatHandler.resolveLevelEntity(levelScope, canonicalId) ?? ownerSession?.entities.get(canonicalId) ?? entity
                : entity;
            const candidateId = Math.max(0, Math.round(Number(candidate?.id ?? canonicalId)));
            const seenId = candidateId > 0 ? candidateId : canonicalId;
            if (seenId <= 0 || seenIds.has(seenId)) {
                return;
            }

            seenIds.add(seenId);
            candidates.push(candidate);
        };

        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (levelMap) {
            for (const entity of levelMap.values()) {
                add(entity);
            }
        }

        for (const session of GlobalState.sessionsByToken.values()) {
            if (!CombatHandler.isSessionPresentForHostileRegen(session, levelScope)) {
                continue;
            }
            for (const entity of session.entities.values()) {
                add(entity, session);
            }
        }

        return candidates;
    }

    static processOutOfCombatRegen(levelScope: string, nowMs: number = Date.now()): void {
        if (!levelScope) {
            return;
        }

        for (const session of GlobalState.sessionsByToken.values()) {
            if (!session.playerSpawned || getClientLevelScope(session) !== levelScope) {
                continue;
            }

            CombatHandler.processPlayerOutOfCombatRegen(session, nowMs);
        }

        for (const entity of CombatHandler.collectHostileRegenCandidates(levelScope)) {
            CombatHandler.processHostileOutOfCombatRegen(levelScope, entity, nowMs);
        }
    }

    private static buildPowerCastPayload(info: PowerCastRelayInfo): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(info.sourceId);
        bb.writeMethod4(info.powerId);
        bb.writeMethod15(info.hasTargetEntity);
        bb.writeMethod15(info.hasTargetPos && Boolean(info.targetPos));
        if (info.hasTargetPos && info.targetPos) {
            bb.writeMethod24(Math.round(info.targetPos.x));
            bb.writeMethod24(Math.round(info.targetPos.y));
        }
        bb.writeMethod15(info.projectileId !== null);
        if (info.projectileId !== null) {
            bb.writeMethod4(Math.max(0, Math.round(info.projectileId)));
        }
        bb.writeMethod15(info.isPersistent);
        bb.writeMethod15(info.comboData !== null);
        if (info.comboData) {
            bb.writeMethod15(info.comboData.isMelee);
            bb.writeMethod4(Math.max(0, Math.round(info.comboData.id)));
        }
        bb.writeMethod15(false);
        return bb.toBuffer();
    }

    private static buildPowerHitPayload(info: PowerHitRelayInfo, damage: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(info.targetId);
        bb.writeMethod4(info.sourceId);
        bb.writeMethod24(CombatHandler.clampRelayPowerHitDamage(damage));
        bb.writeMethod4(info.powerId);
        bb.writeMethod15(info.animOverrideId !== null);
        if (info.animOverrideId !== null) {
            bb.writeMethod4(info.animOverrideId);
        }
        bb.writeMethod15(info.effectOverrideId !== null);
        if (info.effectOverrideId !== null) {
            bb.writeMethod4(info.effectOverrideId);
        }
        bb.writeMethod15(info.isCrit);
        return bb.toBuffer();
    }

    private static buildBuffTickDotPayload(info: BuffTickDotInfo): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(info.targetId);
        bb.writeMethod4(info.sourceId);
        bb.writeMethod4(info.powerId);
        bb.writeMethod45(info.rawDamage);
        bb.writeMethod20(5, Math.max(0, Math.round(Number(info.tailBits) || 0)) & 0x1F);
        return bb.toBuffer();
    }

    private static getBufferBit(data: Buffer, bitIndex: number): number {
        const byteIndex = Math.floor(bitIndex / 8);
        const bitOffset = bitIndex & 7;
        return (data[byteIndex] >> (7 - bitOffset)) & 1;
    }

    private static packBits(bits: number[]): Buffer {
        while (bits.length % 8 !== 0) {
            bits.push(0);
        }

        const out = Buffer.alloc(bits.length / 8);
        for (let i = 0; i < bits.length; i += 8) {
            let byte = 0;
            for (let j = 0; j < 8; j++) {
                byte = (byte << 1) | (bits[i + j] & 1);
            }
            out[i / 8] = byte;
        }
        return out;
    }

    private static encodeMethod9Bits(value: number): number[] {
        const normalized = Math.max(0, Math.round(Number(value) || 0));
        let bitLen = normalized > 0 ? Math.floor(Math.log2(normalized)) + 1 : 1;
        if (bitLen % 2 !== 0) {
            bitLen += 1;
        }
        const prefix = (bitLen / 2) - 1;
        const bits: number[] = [];
        for (let i = 3; i >= 0; i--) {
            bits.push((prefix >> i) & 1);
        }
        for (let i = bitLen - 1; i >= 0; i--) {
            bits.push((normalized >> i) & 1);
        }
        return bits;
    }

    private static leadingMethod9BitLength(data: Buffer): number {
        if (!data.length) {
            return 0;
        }

        const prefix = (CombatHandler.getBufferBit(data, 0) << 3) |
            (CombatHandler.getBufferBit(data, 1) << 2) |
            (CombatHandler.getBufferBit(data, 2) << 1) |
            CombatHandler.getBufferBit(data, 3);
        return 4 + ((prefix + 1) * 2);
    }

    private static replaceLeadingMethod9(data: Buffer, nextValue: number): Buffer {
        const skipBits = CombatHandler.leadingMethod9BitLength(data);
        if (skipBits <= 0 || skipBits > data.length * 8) {
            return data;
        }

        const bits = CombatHandler.encodeMethod9Bits(nextValue);
        for (let i = skipBits; i < data.length * 8; i++) {
            bits.push(CombatHandler.getBufferBit(data, i));
        }
        return CombatHandler.packBits(bits);
    }

    private static trailingBitsAfterLeadingMethod9Hex(data: Buffer): string {
        const skipBits = CombatHandler.leadingMethod9BitLength(data);
        if (skipBits <= 0 || skipBits >= data.length * 8) {
            return '';
        }

        const bits: number[] = [];
        for (let i = skipBits; i < data.length * 8; i++) {
            bits.push(CombatHandler.getBufferBit(data, i));
        }
        return CombatHandler.packBits(bits).toString('hex');
    }

    private static parseBuffTargetEntityId(data: Buffer): number {
        try {
            return new BitReader(data).readMethod9();
        } catch {
            return 0;
        }
    }

    private static packetLabel(packetId: number): string {
        return `0x${packetId.toString(16).toUpperCase().padStart(2, '0')}`;
    }

    private static translateEntityIdForViewer(viewer: Client, packetId: number, entityId: number): number | null {
        const levelScope = getClientLevelScope(viewer);
        const canonicalId = Math.max(0, Math.round(Number(entityId) || 0));
        const resolution = EntityHandler.resolveHostileLocalIdForViewer(
            viewer,
            levelScope,
            canonicalId,
            CombatHandler.packetLabel(packetId)
        );
        if (!resolution.ok) {
            return null;
        }
        if (resolution.entity && resolution.localId !== canonicalId) {
        } else if (resolution.entity && resolution.localId === canonicalId) {
        }
        return resolution.localId;
    }

    private static translateOutboundPacketForViewer(viewer: Client, packetId: number, data: Buffer): Buffer | null {
        try {
            switch (packetId) {
                case 0x09: {
                    const info = CombatHandler.parsePowerCastRelayInfo(data);
                    if (!info) {
                        return data;
                    }

                    const sourceId = CombatHandler.translateEntityIdForViewer(viewer, packetId, info.sourceId);
                    if (sourceId === null) {
                        return null;
                    }
                    if (sourceId === info.sourceId) {
                        return data;
                    }

                    return CombatHandler.buildPowerCastPayload({
                        ...info,
                        sourceId
                    });
                }
                case 0x0A: {
                    const info = CombatHandler.parsePowerHitRelayInfo(data);
                    if (!info) {
                        return data;
                    }

                    const targetId = CombatHandler.translateEntityIdForViewer(viewer, packetId, info.targetId);
                    const sourceId = CombatHandler.translateEntityIdForViewer(viewer, packetId, info.sourceId);
                    if (targetId === null || sourceId === null) {
                        return null;
                    }
                    if (targetId === info.targetId && sourceId === info.sourceId) {
                        return data;
                    }

                    return CombatHandler.buildPowerHitPayload({
                        ...info,
                        targetId,
                        sourceId
                    }, info.damage);
                }
                case 0x79: {
                    const info = CombatHandler.parseBuffTickDotInfo(data);
                    if (!info) {
                        return data;
                    }

                    const targetId = CombatHandler.translateEntityIdForViewer(viewer, packetId, info.targetId);
                    const sourceId = CombatHandler.translateEntityIdForViewer(viewer, packetId, info.sourceId);
                    if (targetId === null || sourceId === null) {
                        return null;
                    }
                    if (targetId === info.targetId && sourceId === info.sourceId) {
                        return data;
                    }

                    return CombatHandler.buildBuffTickDotPayload({
                        ...info,
                        targetId,
                        sourceId
                    });
                }
                case 0x0B:
                case 0x0C: {
                    const entityId = CombatHandler.parseBuffTargetEntityId(data);
                    const localEntityId = CombatHandler.translateEntityIdForViewer(viewer, packetId, entityId);
                    if (localEntityId === null) {
                        return null;
                    }
                    if (entityId <= 0 || localEntityId === entityId) {
                        return data;
                    }

                    return CombatHandler.replaceLeadingMethod9(data, localEntityId);
                }
                case 0x07: {
                    const br = new BitReader(data);
                    const entityId = br.readMethod4();
                    const localEntityId = CombatHandler.translateEntityIdForViewer(viewer, packetId, entityId);
                    if (localEntityId === null) {
                        return null;
                    }
                    if (localEntityId === entityId) {
                        return data;
                    }

                    const x = br.readMethod45();
                    const y = br.readMethod45();
                    const v = br.readMethod45();
                    const entState = br.readMethod20(2);
                    const flags = [
                        br.readMethod15(),
                        br.readMethod15(),
                        br.readMethod15(),
                        br.readMethod15(),
                        br.readMethod15(),
                        br.readMethod15()
                    ];
                    return CombatHandler.buildEntityStatePayloadFromParts(localEntityId, x, y, v, entState, flags);
                }
                case 0x0D: {
                    const br = new BitReader(data);
                    const entityId = br.readMethod4();
                    const localEntityId = CombatHandler.translateEntityIdForViewer(viewer, packetId, entityId);
                    if (localEntityId === null) {
                        return null;
                    }
                    if (localEntityId === entityId) {
                        return data;
                    }

                    const immediate = br.readMethod15();
                    return CombatHandler.buildDestroyEntityPayload(localEntityId, immediate);
                }
                case 0x78: {
                    const br = new BitReader(data);
                    const entityId = br.readMethod4();
                    const localEntityId = CombatHandler.translateEntityIdForViewer(viewer, packetId, entityId);
                    if (localEntityId === null) {
                        return null;
                    }
                    if (localEntityId === entityId) {
                        return data;
                    }

                    return CombatHandler.buildHpDeltaPayload(localEntityId, br.readMethod45());
                }
                case 0x82: {
                    const br = new BitReader(data);
                    const entityId = br.readMethod9();
                    const localEntityId = CombatHandler.translateEntityIdForViewer(viewer, packetId, entityId);
                    if (localEntityId === null) {
                        return null;
                    }
                    if (localEntityId === entityId) {
                        return data;
                    }

                    const bb = new BitBuffer(false);
                    bb.writeMethod4(localEntityId);
                    bb.writeMethod24(br.readMethod24());
                    return bb.toBuffer();
                }
                default:
                    return data;
            }
        } catch {
            return data;
        }
    }

    private static sendTranslatedPacket(viewer: Client, packetId: number, data: Buffer): boolean {
        const translated = CombatHandler.translateOutboundPacketForViewer(viewer, packetId, data);
        if (!translated) {
            return false;
        }
        viewer.send(packetId, translated);
        return true;
    }

    private static resolveClientEntityAliases(client: Client, info: PowerHitRelayInfo): PowerHitRelayInfo {
        const levelScope = getClientLevelScope(client);
        const targetId = CombatHandler.resolveClientHostileEntityAlias(
            client,
            levelScope,
            EntityHandler.resolveEntityAlias(client, info.targetId)
        );
        const sourceId = CombatHandler.resolveClientHostileEntityAlias(
            client,
            levelScope,
            EntityHandler.resolveEntityAlias(client, info.sourceId)
        );
        if (targetId === info.targetId && sourceId === info.sourceId) {
            return info;
        }

        return {
            ...info,
            targetId,
            sourceId
        };
    }

    private static clearHostileAggroTargetForPlayer(entity: any, client: Client): void {
        if (!entity || typeof entity !== 'object' || client.clientEntID <= 0) {
            return;
        }

        const aggroTargetEntityId = Math.max(0, Math.round(Number(entity.aggroTargetEntityId ?? 0)));
        const aggroTargetToken = Math.max(0, Math.round(Number(entity.aggroTargetToken ?? 0)));
        if (aggroTargetEntityId !== client.clientEntID && aggroTargetToken !== client.token) {
            return;
        }

        entity.aggroTargetEntityId = 0;
        delete entity.aggroTargetToken;
        entity.nextAttack = 0;
    }

    private static returnHostileToRoomBossHome(levelScope: string, entity: any): void {
        const entityId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        const knownHome = CombatHandler.getKnownDungeonBossHomePosition(levelScope, entity);
        const homeX = Math.round(Number(knownHome?.x ?? entity?.roomBossHomeX ?? entity?.spawnX ?? entity?.homeX ?? NaN));
        const homeY = Math.round(Number(knownHome?.y ?? entity?.roomBossHomeY ?? entity?.spawnY ?? entity?.homeY ?? NaN));
        const currentX = Math.round(Number(entity?.x ?? NaN));
        const currentY = Math.round(Number(entity?.y ?? NaN));
        if (
            !levelScope ||
            entityId <= 0 ||
            !Number.isFinite(homeX) ||
            !Number.isFinite(homeY) ||
            !Number.isFinite(currentX) ||
            !Number.isFinite(currentY)
        ) {
            return;
        }

        const deltaX = homeX - currentX;
        const deltaY = homeY - currentY;
        if (deltaX === 0 && deltaY === 0) {
            return;
        }

        const apply = (copy: any): void => {
            if (!copy || typeof copy !== 'object' || Math.round(Number(copy.id ?? 0)) !== entityId) {
                return;
            }
            copy.x = homeX;
            copy.y = homeY;
            copy.v = 0;
            copy.bRunning = false;
            copy.bBackpedal = false;
        };

        apply(GlobalState.levelEntities.get(levelScope)?.get(entityId));
        for (const session of GlobalState.sessionsByToken.values()) {
            if (getClientLevelScope(session) === levelScope) {
                apply(session.entities.get(entityId));
            }
        }

        const payload = CombatHandler.buildEntityStatePayloadFromParts(
            entityId,
            deltaX,
            deltaY,
            0,
            Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD ? EntityState.ACTIVE : Number(entity.entState ?? EntityState.ACTIVE),
            [Boolean(entity.facingLeft), false, false, false, false, false]
        );
        CombatHandler.broadcastEntityViewPacket(levelScope, entity, 0x07, payload, [entityId]);
    }

    private static armBossRegenForPlayerDeath(client: Client, nowMs: number = Date.now(), forceRearm: boolean = false): void {
        if (!client.currentLevel) {
            return;
        }

        const levelScope = getClientLevelScope(client);
        client.enemyDeathRegenArmed = true;
        const deathRegenArmKey = CombatHandler.getDeathRegenArmKeyForPlayer(client);
        let armedBossCount = 0;

        for (const entity of CombatHandler.collectHostileRegenCandidates(levelScope)) {
            const entityId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
            if (entityId <= 0 || EntityHandler.isClientOwnPlayerEntity(client, levelScope, entityId, entity)) {
                continue;
            }
            if (
                Boolean(entity?.isPlayer) ||
                Number(entity?.team ?? 0) !== EntityTeam.ENEMY ||
                !CombatHandler.isDungeonBossEntity(levelScope, entity)
            ) {
                continue;
            }

            const alreadyArmedForThisDeath = String(entity.deathRegenArmedForPlayerKey ?? '') === deathRegenArmKey;
            CombatHandler.clearHostileAggroTargetForPlayer(entity, client);
            CombatHandler.returnHostileToRoomBossHome(levelScope, entity);
            if (forceRearm || !alreadyArmedForThisDeath) {
                CombatHandler.setHostileDeathRegenArm(levelScope, entity, deathRegenArmKey);
                CombatHandler.setEntityCombatActivity(
                    entity,
                    Math.max(1, nowMs - CombatHandler.DUNGEON_BOSS_OUT_OF_COMBAT_REGEN_DELAY_MS)
                );
                CombatHandler.setEntityLastRegenTickAt(entity, 0);
            }
            armedBossCount++;
        }

        for (const entity of CombatHandler.collectHostileRegenCandidates(levelScope)) {
            CombatHandler.processHostileOutOfCombatRegen(levelScope, entity, nowMs);
        }
    }

    static notePlayerDeathState(client: Client, nowMs: number = Date.now()): void {
        if (!client.character || client.clientEntID <= 0) {
            return;
        }

        const levelScope = getClientLevelScope(client);
        const localEntity = client.entities.get(client.clientEntID);
        const levelEntity = CombatHandler.resolveLevelEntity(levelScope, client.clientEntID);
        const hasActivePositiveSnapshot =
            CombatHandler.isEntityActiveWithPositiveHp(localEntity) ||
            CombatHandler.isEntityActiveWithPositiveHp(levelEntity);
        const wasAlreadyDead = !hasActivePositiveSnapshot && CombatHandler.isPlayerSessionDead(client);
        const deathRegenWasArmed = Boolean(client.enemyDeathRegenArmed);
        const entity = localEntity;
        if (entity && typeof entity === 'object') {
            entity.dead = true;
            entity.entState = EntityState.DEAD;
            entity.hp = 0;
        }

        if (levelEntity && typeof levelEntity === 'object') {
            levelEntity.dead = true;
            levelEntity.entState = EntityState.DEAD;
            levelEntity.hp = 0;
        }

        client.authoritativeCurrentHp = 0;
        CombatHandler.armBossRegenForPlayerDeath(client, nowMs, !wasAlreadyDead || !deathRegenWasArmed);
    }

    private static clearEnemyDeathRegenArm(client: Client): void {
        client.enemyDeathRegenArmed = false;
        const levelScope = getClientLevelScope(client);
        if (!levelScope) {
            return;
        }

        const deathRegenArmKey = CombatHandler.getDeathRegenArmKeyForPlayer(client);
        for (const entity of CombatHandler.collectHostileRegenCandidates(levelScope)) {
            CombatHandler.clearHostileDeathRegenArm(levelScope, entity, deathRegenArmKey);
        }
    }

    private static clearLevelEnemyRewardTrackingForRespawn(client: Client): void {
        if (!client.currentLevel) {
            return;
        }

        const levelScope = getClientLevelScope(client);
        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (!levelMap) {
            return;
        }

        for (const [entityId, entity] of levelMap.entries()) {
            if (entityId <= 0 || EntityHandler.isClientOwnPlayerEntity(client, levelScope, entityId, entity)) {
                continue;
            }
            if (Boolean(entity?.isPlayer) || Number(entity?.team ?? 0) !== 2) {
                continue;
            }

            CombatHandler.clearEntityRewardTracking(levelScope, entityId);
        }
    }

    private static findPlayerSessionByEntityId(entityId: number): Client | null {
        for (const other of GlobalState.sessionsByToken.values()) {
            if (other.clientEntID === entityId && other.character) {
                return other;
            }
        }

        return null;
    }

    private static resolveLevelEntity(levelName: string, entityId: number): any {
        if (!levelName || entityId <= 0) {
            return null;
        }

        return GlobalState.levelEntities.get(levelName)?.get(entityId) ?? null;
    }

    private static shouldSuppressCutsceneHostileCombat(client: Client, levelScope: string, sourceId: number): boolean {
        if (!LevelHandler.isDungeonCutsceneCombatLocked(client) || !levelScope || sourceId <= 0) {
            return false;
        }

        const sourceEntity = CombatHandler.resolveLevelEntity(levelScope, sourceId) ?? client.entities.get(sourceId);
        return Boolean(sourceEntity && !sourceEntity.isPlayer && Number(sourceEntity.team ?? 0) === EntityTeam.ENEMY);
    }

    private static shouldMirrorClientSpawnEntityToParty(levelName: string, entity: any): boolean {
        return EntityHandler.shouldMirrorClientSpawnEntityToParty(levelName, entity);
    }

    private static canReceivePartySharedHostileHealthSync(anchor: Client, viewer: Client, levelScope: string): boolean {
        return Boolean(
            viewer.playerSpawned &&
            getClientLevelScope(viewer) === levelScope &&
            (
                viewer === anchor ||
                TutorialDungeonMechanics.isTutorialDungeon(levelScope) ||
                areClientsInSameParty(anchor, viewer)
            )
        );
    }

    private static getPartySharedHostileHpApplyKey(levelScope: string, entityId: number): string {
        return `${levelScope}:${Math.max(0, Math.round(Number(entityId) || 0))}`;
    }

    private static rememberPartySharedHostileHpApply(levelScope: string, entityId: number): void {
        CombatHandler.recentPartySharedHostileHpApplies.set(
            CombatHandler.getPartySharedHostileHpApplyKey(levelScope, entityId),
            Date.now()
        );
    }

    private static didRecentlyApplyPartySharedHostileHp(levelScope: string, entityId: number): boolean {
        const key = CombatHandler.getPartySharedHostileHpApplyKey(levelScope, entityId);
        const lastAt = Math.max(0, Math.round(Number(CombatHandler.recentPartySharedHostileHpApplies.get(key) ?? 0)));
        const now = Date.now();
        if (lastAt <= 0) {
            return false;
        }
        if (now - lastAt > CombatHandler.PARTY_SHARED_HOSTILE_HP_DEDUPE_MS) {
            CombatHandler.recentPartySharedHostileHpApplies.delete(key);
            return false;
        }

        return true;
    }

    private static snapshotPartySharedHostileViewerHealth(
        anchor: Client,
        levelScope: string,
        entity: any
    ): Map<number, HostileViewerHealthSnapshot> {
        const snapshots = new Map<number, HostileViewerHealthSnapshot>();
        const canonicalId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        if (
            !levelScope ||
            canonicalId <= 0 ||
            !CombatHandler.shouldMirrorClientSpawnEntityToParty(getScopeLevelName(levelScope), entity)
        ) {
            return snapshots;
        }

        for (const viewer of GlobalState.sessionsByToken.values()) {
            if (!CombatHandler.canReceivePartySharedHostileHealthSync(anchor, viewer, levelScope)) {
                continue;
            }

            const localId = CombatHandler.resolvePartySharedHostileLocalIdForViewer(viewer, levelScope, canonicalId, entity);
            if (localId <= 0) {
                continue;
            }
            const canResolve =
                viewer.entities.has(localId) ||
                viewer.knownEntityIds.has(localId);
            if (!canResolve) {
                continue;
            }

            const localEntity = viewer.entities.get(localId) ?? entity;
            const previousMaxHp = Math.max(0, Math.round(Number(localEntity?.maxHp ?? entity?.maxHp ?? 0)));
            const rawPreviousHp = Number(localEntity?.hp ?? entity?.hp ?? NaN);
            const previousHp = Number.isFinite(rawPreviousHp)
                ? Math.max(0, Math.round(rawPreviousHp))
                : previousMaxHp;
            snapshots.set(viewer.token, {
                localId,
                previousHp,
                previousMaxHp
            });
        }

        return snapshots;
    }

    private static resolvePartySharedHostileLocalIdForViewer(
        viewer: Client,
        levelScope: string,
        canonicalId: number,
        canonicalEntity: any = null
    ): number {
        const entityId = Math.max(0, Math.round(Number(canonicalId) || 0));
        if (!levelScope || entityId <= 0) {
            return entityId;
        }

        const sharedEntity = canonicalEntity ?? CombatHandler.resolveLevelEntity(levelScope, entityId);
        if (
            !sharedEntity ||
            !CombatHandler.shouldMirrorClientSpawnEntityToParty(getScopeLevelName(levelScope), sharedEntity)
        ) {
            const existingLocalId = EntityHandler.resolveEntityLocalId(viewer, entityId);
            return existingLocalId > 0 ? existingLocalId : entityId;
        }

        const registeredLocalId = EntityHandler.getRegisteredHostileLocalIdForViewer(viewer, sharedEntity);
        if (registeredLocalId > 0) {
            return registeredLocalId;
        }

        const strictResolution = EntityHandler.resolveHostileLocalIdForViewer(
            viewer,
            levelScope,
            entityId,
            'death-relay'
        );
        if (strictResolution.ok && strictResolution.entity && strictResolution.localId > 0) {
            return strictResolution.localId;
        }

        for (const [candidateIdValue, candidate] of viewer.entities.entries()) {
            const candidateId = Math.max(0, Math.round(Number(candidateIdValue) || 0));
            if (
                candidateId <= 0 ||
                candidateId === entityId ||
                !CombatHandler.shouldMirrorClientSpawnEntityToParty(getScopeLevelName(levelScope), candidate) ||
                !CombatHandler.isEquivalentHostileEntity(levelScope, sharedEntity, candidate)
            ) {
                continue;
            }

            EntityHandler.rememberEntityAlias(viewer, candidateId, entityId);
            viewer.knownEntityIds?.add(entityId);
            EntityHandler.registerCanonicalHostileAlias(viewer, levelScope, sharedEntity, candidateId, 'equivalent_local_backfill');
            return candidateId;
        }

        return 0;
    }

    static resolvePartySharedHostileLocalIdForSharedState(
        viewer: Client,
        levelScope: string,
        canonicalId: number,
        canonicalEntity: any = null
    ): number {
        return CombatHandler.resolvePartySharedHostileLocalIdForViewer(viewer, levelScope, canonicalId, canonicalEntity);
    }

    private static buildRemoveBuffPayloadFromSnapshot(snapshot: ServerAuthorityBuffSnapshot, targetId: number): Buffer {
        const payload = snapshot.payloadHex ? Buffer.from(snapshot.payloadHex, 'hex') : Buffer.alloc(0);
        if (payload.length > 0) {
            return CombatHandler.replaceLeadingMethod9(payload, targetId);
        }

        const bb = new BitBuffer(false);
        bb.writeMethod4(targetId);
        if (snapshot.buffId > 0) {
            bb.writeMethod4(snapshot.buffId);
        }
        return bb.toBuffer();
    }

    private static broadcastCanonicalBuffRemoval(
        levelScope: string,
        entity: any,
        snapshot: ServerAuthorityBuffSnapshot,
        reason: string
    ): void {
        const canonicalId = Math.max(0, Math.round(Number(entity?.id ?? snapshot.targetId ?? 0)));
        if (!levelScope || canonicalId <= 0) {
            return;
        }

        const canonicalPayload = CombatHandler.buildRemoveBuffPayloadFromSnapshot(snapshot, canonicalId);
        for (const viewer of GlobalState.sessionsByToken.values()) {
            if (!viewer.playerSpawned || getClientLevelScope(viewer) !== levelScope) {
                continue;
            }
            if (!CombatHandler.canViewerResolveCombatEntity(viewer, levelScope, canonicalId)) {
                continue;
            }

            CombatHandler.sendTranslatedPacket(viewer, 0x0C, canonicalPayload);
        }
    }

    private static clearCanonicalHostileBuffs(levelScope: string, entity: any, reason: string): void {
        if (!entity || typeof entity !== 'object') {
            return;
        }

        const activeBuffs = CombatHandler.getServerAuthorityActiveBuffs(entity);
        const snapshots = Object.values(activeBuffs);
        if (snapshots.length === 0) {
            entity.activeBuffs = {};
            return;
        }

        for (const snapshot of snapshots) {
            CombatHandler.broadcastCanonicalBuffRemoval(levelScope, entity, snapshot, reason);
            delete activeBuffs[snapshot.key];
        }
        entity.activeBuffs = {};
        entity.buffStateVersion = Math.max(0, Math.round(Number(entity.buffStateVersion ?? 0))) + 1;
        entity.lastBuffStateAt = Date.now();
        const canonicalId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        for (const viewer of GlobalState.sessionsByToken.values()) {
            if (getClientLevelScope(viewer) === levelScope) {
                CombatHandler.mirrorServerAuthorityBuffStateToViewerCache(viewer, canonicalId, entity);
            }
        }
    }

    private static finalizeHostileDeath(
        anchor: Client,
        levelScope: string,
        entityId: number,
        entity: any,
        options: { includeAnchor?: boolean; sendHpCorrection?: boolean; destroyLocal?: boolean; reason?: string } = {}
    ): void {
        if (!levelScope || entityId <= 0 || !entity || entity.isPlayer || Number(entity.team ?? 0) !== EntityTeam.ENEMY) {
            return;
        }

        const maxHp = Math.max(1, Math.round(Number(entity.maxHp ?? 0)) || CombatHandler.estimateHostileMaxHp(entity) || 1);
        const hpBefore = Math.max(0, Math.round(Number(entity.hp ?? 0)));
        const alreadyDestroyed = Boolean(entity.destroyed) || Math.max(0, Math.round(Number(entity.deathFinalizedAt ?? 0))) > 0;
        const finalizedAt = Date.now();
        if (!alreadyDestroyed) {
            entity.deathVersion = Math.max(0, Math.round(Number(entity.deathVersion ?? 0))) + 1;
        } else {
            entity.deathVersion = Math.max(1, Math.round(Number(entity.deathVersion ?? 1)));
        }
        if (hpBefore > 0 || !Boolean(entity.dead) || !Boolean(entity.destroyed)) {
            CombatHandler.incrementHostileHpVersion(entity);
        }
        entity.maxHp = maxHp;
        entity.hp = 0;
        entity.healthDelta = -maxHp;
        entity.health_delta = -maxHp;
        entity.dead = true;
        entity.destroyed = true;
        if (TutorialDungeonMechanics.isCompletionBoss(levelScope, entity)) {
            entity.bossDeathCommitted = true;
            entity.bossRespawnBlocked = true;
        }
        entity.entState = EntityState.DEAD;
        entity.deathFinalizedAt = Math.max(0, Math.round(Number(entity.deathFinalizedAt ?? 0))) || finalizedAt;
        entity.finalDeathReason = options.reason ?? 'hostile_death';
        entity.aggroTargetEntityId = 0;
        entity.aggroTargetToken = 0;
        entity.targetEntityId = 0;
        entity.targetToken = 0;
        entity.nextAttack = 0;
        CombatHandler.clearCanonicalHostileBuffs(levelScope, entity, options.reason ?? 'hostile_death');

        const levelEntity = GlobalState.levelEntities.get(levelScope)?.get(entityId);
        if (levelEntity && levelEntity !== entity) {
            levelEntity.maxHp = maxHp;
            levelEntity.hp = 0;
            levelEntity.healthDelta = -maxHp;
            levelEntity.health_delta = -maxHp;
            levelEntity.dead = true;
            levelEntity.destroyed = true;
            if (TutorialDungeonMechanics.isCompletionBoss(levelScope, levelEntity)) {
                levelEntity.bossDeathCommitted = true;
                levelEntity.bossRespawnBlocked = true;
            }
            levelEntity.entState = EntityState.DEAD;
            levelEntity.deathFinalizedAt = Math.max(0, Math.round(Number(levelEntity.deathFinalizedAt ?? 0))) || entity.deathFinalizedAt;
            levelEntity.finalDeathReason = options.reason ?? 'hostile_death_level_copy';
            levelEntity.aggroTargetEntityId = 0;
            levelEntity.aggroTargetToken = 0;
            levelEntity.targetEntityId = 0;
            levelEntity.targetToken = 0;
            levelEntity.nextAttack = 0;
            levelEntity.hpVersion = Math.max(
                Math.max(0, Math.round(Number(levelEntity.hpVersion ?? 0))),
                Math.max(0, Math.round(Number(entity.hpVersion ?? 0)))
            );
            levelEntity.deathVersion = Math.max(
                Math.max(0, Math.round(Number(levelEntity.deathVersion ?? 0))),
                Math.max(0, Math.round(Number(entity.deathVersion ?? 0)))
            );
            CombatHandler.clearCanonicalHostileBuffs(levelScope, levelEntity, options.reason ?? 'hostile_death_level_copy');
        }

        if (CombatHandler.isServerAuthoritySyncNpc(levelScope, entity)) {
            EntityHandler.noteServerAuthorityHostileDestroyed(levelScope, entityId, entity, anchor.token);
        }
        if (TutorialDungeonMechanics.isCompletionBoss(levelScope, entity)) {
            TutorialDungeonMechanics.noteBossHealth(anchor, entity);
        }

        let viewers = 0;
        if (CombatHandler.isServerAuthoritySyncNpc(levelScope, entity)) {
            const canonicalEntity = GlobalState.levelEntities.get(levelScope)?.get(entityId) ?? entity;
            for (const viewer of GlobalState.sessionsByToken.values()) {
                if (!CombatHandler.canReceiveServerAuthorityNpcRelay(anchor, viewer, levelScope)) {
                    continue;
                }

                const resolved = EntityHandler.resolveHostileLocalIdForViewer(
                    viewer,
                    levelScope,
                    entityId,
                    'death-correction'
                );
                const registeredLocalId = EntityHandler.getRegisteredHostileLocalIdForViewer(
                    viewer,
                    canonicalEntity
                );
                const isTutorialCompletionBoss = TutorialDungeonMechanics.isCompletionBoss(
                    levelScope,
                    canonicalEntity
                );
                const resolvedLocalId = resolved.ok && resolved.localId > 0
                    ? resolved.localId
                    : isTutorialCompletionBoss && registeredLocalId > 0
                        ? registeredLocalId
                        : isTutorialCompletionBoss
                            ? EntityHandler.resolveEntityLocalId(viewer, entityId)
                            : 0;
                if (resolvedLocalId <= 0) {
                    continue;
                }
                if (CombatHandler.sendHostileDeathCorrectionToViewer(
                    viewer,
                    levelScope,
                    canonicalEntity,
                    resolvedLocalId,
                    options.reason ?? 'hostile_death'
                )) {
                    viewers++;
                }
            }

            CombatHandler.handleCanonicalVisibleServerAuthorityDefeatSideEffects(anchor, levelScope, entity);
        }
    }

    private static convergePartySharedHostileHealthToParty(
        anchor: Client,
        levelScope: string,
        entity: any,
        snapshots: Map<number, HostileViewerHealthSnapshot>,
        sourceExpectedLocalDelta: number,
        viewerExpectedLocalDelta: number
    ): void {
        const canonicalId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        if (
            !levelScope ||
            canonicalId <= 0 ||
            !CombatHandler.shouldMirrorClientSpawnEntityToParty(getScopeLevelName(levelScope), entity)
        ) {
            return;
        }

        const canonicalHp = Math.max(0, Math.round(Number(entity?.hp ?? 0)));
        const maxHp = Math.max(1, Math.round(Number(entity?.maxHp ?? 0)) || CombatHandler.estimateHostileMaxHp(entity) || 1);
        const canonicalDead = Boolean(entity?.dead) ||
            Number(entity?.entState ?? EntityState.ACTIVE) === EntityState.DEAD ||
            canonicalHp <= 0;

        for (const viewer of GlobalState.sessionsByToken.values()) {
            const snapshot = snapshots.get(viewer.token);
            if (!snapshot || !CombatHandler.canReceivePartySharedHostileHealthSync(anchor, viewer, levelScope)) {
                continue;
            }

            const localId = snapshot.localId > 0 ? snapshot.localId : EntityHandler.resolveEntityLocalId(viewer, canonicalId);
            if (localId <= 0) {
                continue;
            }

            const existing = viewer.entities.get(localId) ?? viewer.entities.get(canonicalId) ?? {};
            viewer.entities.set(localId, {
                ...existing,
                ...entity,
                id: localId,
                clientSpawned: true,
                canonicalEntityId: localId === canonicalId ? undefined : canonicalId,
                sharedCanonicalId: localId === canonicalId ? undefined : canonicalId
            });
            viewer.knownEntityIds.add(canonicalId);

            const previousHp = Number.isFinite(snapshot.previousHp)
                ? Math.max(0, Math.round(snapshot.previousHp))
                : Math.max(0, Math.round(snapshot.previousMaxHp || maxHp));
            const expectedLocalDelta = viewer === anchor
                ? Math.round(Number(sourceExpectedLocalDelta) || 0)
                : Math.round(Number(viewerExpectedLocalDelta) || 0);
            const expectedPostPacketHp = Math.max(0, Math.min(maxHp, previousHp + expectedLocalDelta));
            const correctionDelta = canonicalHp - expectedPostPacketHp;
            if (correctionDelta !== 0) {
                viewer.send(
                    CombatHandler.CLIENT_HEAL_PACKET_ID,
                    CombatHandler.buildHpDeltaPayload(localId, correctionDelta)
                );
            }

            if (canonicalDead) {
                const localEntity = viewer.entities.get(localId);
                if (localEntity && typeof localEntity === 'object') {
                    localEntity.hp = 0;
                    localEntity.dead = true;
                    localEntity.entState = EntityState.DEAD;
                    localEntity.healthDelta = -maxHp;
                    localEntity.health_delta = -maxHp;
                }
                const expectsPendingClientHitToKill = expectedLocalDelta < 0 &&
                    expectedPostPacketHp <= 0 &&
                    correctionDelta === 0;
                if (localEntity && !expectsPendingClientHitToKill) {
                    viewer.send(0x07, CombatHandler.buildEntityStatePayload(localId, EntityState.DEAD, Boolean(localEntity.facingLeft ?? entity?.facingLeft)));
                    viewer.send(0x0D, CombatHandler.buildDestroyEntityPayload(localId, true));
                    viewer.entities.delete(localId);
                    viewer.entities.delete(canonicalId);
                    viewer.knownEntityIds.delete(localId);
                    viewer.knownEntityIds.delete(canonicalId);
                }
            }
        }
    }

    private static getCombatRecipients(anchor: Client, includeAnchor: boolean = false): Client[] {
        const recipients: Client[] = [];
        const levelScope = getClientLevelScope(anchor);
        if (!levelScope || !anchor.playerSpawned) {
            return recipients;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== levelScope) {
                continue;
            }
            if (!includeAnchor && other === anchor) {
                continue;
            }
            if (!shouldShareCombatView(anchor, other)) {
                continue;
            }

            recipients.push(other);
        }

        return recipients;
    }

    private static canViewerResolveAnchoredCombatEntity(
        viewer: Client,
        anchor: Client,
        levelScope: string,
        entityId: number
    ): boolean {
        if (entityId <= 0) {
            return true;
        }

        const canonicalEntity = CombatHandler.resolveLevelEntity(levelScope, entityId);
        if (CombatHandler.shouldMirrorClientSpawnEntityToParty(anchor.currentLevel, canonicalEntity)) {
            return true;
        }

        if (EntityHandler.ensureEntityKnown(viewer, anchor.currentLevel, entityId)) {
            return true;
        }

        if (!areClientsInSameParty(anchor, viewer)) {
            return false;
        }

        return false;
    }

    private static relayPartyLocalEntityDefeat(
        anchor: Client,
        levelScope: string,
        entityId: number,
        defeatedEntity: any = null,
        options: { requireKnownOrLocal?: boolean; sendHpCorrection?: boolean; destroyLocal?: boolean; includeAnchor?: boolean } = {}
    ): void {
        if (!levelScope || entityId <= 0 || !anchor.playerSpawned) {
            return;
        }

        const canonicalEntity = defeatedEntity ?? CombatHandler.resolveLevelEntity(levelScope, entityId);
        CombatHandler.finalizeHostileDeath(anchor, levelScope, entityId, canonicalEntity, {
            includeAnchor: options.includeAnchor,
            sendHpCorrection: options.sendHpCorrection,
            destroyLocal: options.destroyLocal,
            reason: 'party_shared_hostile_death'
        });
        for (const other of GlobalState.sessionsByToken.values()) {
            const localEntityId = CombatHandler.resolvePartySharedHostileLocalIdForViewer(other, levelScope, entityId, canonicalEntity);
            let updateEntityId = localEntityId;
            const clientLocalEntity = other.entities.get(localEntityId) ?? other.entities.get(entityId) ?? null;
            const canResolveSharedEntity =
                EntityHandler.canClientResolveCanonicalEntity(other, entityId) ||
                other.knownEntityIds?.has(entityId) ||
                other.knownEntityIds?.has(localEntityId) ||
                other.entities?.has(entityId) ||
                other.entities?.has(localEntityId);
            let localEntity = clientLocalEntity ?? (!options.requireKnownOrLocal || canResolveSharedEntity ? canonicalEntity : null);
            if (
                localEntity &&
                EntityHandler.isClientOwnPlayerEntity(other, levelScope, localEntityId, localEntity)
            ) {
                const canonicalLocalEntity = other.entities.get(entityId);
                localEntity = canonicalLocalEntity && !Boolean(canonicalLocalEntity.isPlayer)
                    ? canonicalLocalEntity
                    : null;
                updateEntityId = entityId;
            }
            const skipReason = other === anchor && !options.includeAnchor
                ? 'source_client_already_destroyed'
                : !other.playerSpawned
                    ? 'viewer_not_spawned'
                    : getClientLevelScope(other) !== levelScope
                        ? 'scope_mismatch'
                        : !areClientsInSameParty(anchor, other)
                            ? 'not_same_party'
                            : options.requireKnownOrLocal && !canResolveSharedEntity
                                ? 'viewer_has_not_adopted_shared_entity'
                                : localEntityId <= 0
                                    ? 'missing_viewer_local_id'
                                : !localEntity
                                    ? 'missing_entity'
                                    : !CombatHandler.shouldMirrorClientSpawnEntityToParty(anchor.currentLevel, localEntity)
                                        ? 'not_party_mirror_entity'
                                        : '';
            if (skipReason) {
                if (getScopeLevelName(levelScope) === 'JC_Mini1Hard') {
                }
                continue;
            }

            localEntity.dead = true;
            localEntity.hp = 0;
            localEntity.entState = EntityState.DEAD;
            const maxHp = Math.max(0, Math.round(Number(localEntity.maxHp ?? 0)));
            if (maxHp > 0) {
                localEntity.healthDelta = -maxHp;
                localEntity.health_delta = -maxHp;
            }
            other.entities.set(updateEntityId, localEntity);
            other.knownEntityIds.delete(entityId);
            other.knownEntityIds.delete(updateEntityId);
            if (options.sendHpCorrection ?? true) {
                const correctionHp = maxHp || Math.max(0, Math.round(Number(canonicalEntity?.maxHp ?? canonicalEntity?.hp ?? 0)) || 0);
                if (correctionHp > 0) {
                    other.send(0x78, CombatHandler.buildHpDeltaPayload(updateEntityId, -correctionHp));
                }
            }
            other.send(0x07, CombatHandler.buildEntityStatePayload(updateEntityId, EntityState.DEAD, Boolean(localEntity.facingLeft)));
            if (options.destroyLocal ?? true) {
                other.send(0x0D, CombatHandler.buildDestroyEntityPayload(updateEntityId, true));
                other.entities.delete(updateEntityId);
            }
            if (getScopeLevelName(levelScope) === 'JC_Mini1Hard') {
            }
        }
    }

    private static isServerAuthoritySyncNpc(levelScope: string, entity: any): boolean {
        return CombatHandler.SERVER_AUTHORITY_SYNC_LEVELS.has(getScopeLevelName(levelScope)) &&
            EntityHandler.isServerAuthorityHostileEntity(levelScope, entity);
    }

    private static canReceiveServerAuthorityNpcRelay(anchor: Client, viewer: Client, levelScope: string): boolean {
        if (
            viewer.playerSpawned &&
            viewer !== anchor &&
            areClientsInSameParty(anchor, viewer) &&
            CombatHandler.SERVER_AUTHORITY_SYNC_LEVELS.has(getScopeLevelName(levelScope)) &&
            LevelConfig.normalizeLevelName(viewer.currentLevel) === getScopeLevelName(levelScope) &&
            getClientLevelScope(viewer) !== levelScope
        ) {
            const beforeScope = getClientLevelScope(viewer);
            EntityHandler.ensureJcMini1PartySharedScope(viewer, getScopeLevelName(levelScope), 'combat_relay_scope_guard');
        }

        const sameScope = viewer.playerSpawned && getClientLevelScope(viewer) === levelScope;
        if (TutorialDungeonMechanics.isTutorialDungeon(getScopeLevelName(levelScope))) {
            return Boolean(sameScope);
        }

        return Boolean(sameScope && (viewer === anchor || areClientsInSameParty(anchor, viewer)));
    }

    private static refreshServerAuthorityProgressWithRetries(levelScope: string, reason: string): void {
        if (!EntityHandler.usesServerAuthorityHostiles(getScopeLevelName(levelScope))) {
            return;
        }

        const initialProgress = LevelHandler.refreshSharedDungeonQuestProgress(levelScope);
        for (const delayMs of [150, 500, 1200]) {
            setTimeout(() => {
                const progress = LevelHandler.refreshSharedDungeonQuestProgress(levelScope);
            }, delayMs).unref?.();
        }
    }

    private static getServerAuthorityProxyHpApplyKey(levelScope: string, entityId: number): string {
        return `${levelScope}:${Math.max(0, Math.round(Number(entityId) || 0))}`;
    }

    private static rememberServerAuthorityProxyHpApply(levelScope: string, entityId: number): void {
        const key = CombatHandler.getServerAuthorityProxyHpApplyKey(levelScope, entityId);
        CombatHandler.recentServerAuthorityProxyHpApplies.set(key, Date.now());
    }

    private static didRecentlyApplyServerAuthorityProxyHp(levelScope: string, entityId: number): boolean {
        const key = CombatHandler.getServerAuthorityProxyHpApplyKey(levelScope, entityId);
        const lastAt = Math.max(0, Math.round(Number(CombatHandler.recentServerAuthorityProxyHpApplies.get(key) ?? 0)));
        const now = Date.now();
        if (lastAt <= 0) {
            return false;
        }
        if (now - lastAt > CombatHandler.SERVER_AUTHORITY_PROXY_HP_DEDUPE_MS) {
            CombatHandler.recentServerAuthorityProxyHpApplies.delete(key);
            return false;
        }

        return true;
    }

    private static getServerAuthorityViewerEntityState(viewer: Client, canonicalId: number): {
        localId: number;
        hp: number;
        maxHp: number;
        dead: boolean;
        entState: number;
        knownCanonical: boolean;
        knownLocal: boolean;
        hasCanonicalEntity: boolean;
        hasLocalEntity: boolean;
    } {
        const localId = EntityHandler.resolveEntityLocalId(viewer, canonicalId);
        const localEntity = viewer.entities.get(localId) ?? viewer.entities.get(canonicalId);
        return {
            localId,
            hp: Math.round(Number(localEntity?.hp ?? NaN)),
            maxHp: Math.round(Number(localEntity?.maxHp ?? 0)),
            dead: Boolean(localEntity?.dead) || Number(localEntity?.entState ?? EntityState.ACTIVE) === EntityState.DEAD,
            entState: Math.round(Number(localEntity?.entState ?? EntityState.ACTIVE)),
            knownCanonical: viewer.knownEntityIds.has(canonicalId),
            knownLocal: viewer.knownEntityIds.has(localId),
            hasCanonicalEntity: viewer.entities.has(canonicalId),
            hasLocalEntity: viewer.entities.has(localId)
        };
    }

    private static ensureServerAuthorityNpcKnown(
        viewer: Client,
        levelScope: string,
        entity: any,
        reason: string
    ): boolean {
        const canonicalId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        if (canonicalId <= 0) {
            return false;
        }

        const before = CombatHandler.getServerAuthorityViewerEntityState(viewer, canonicalId);
        if (CombatHandler.canViewerResolveCombatEntity(viewer, levelScope, canonicalId)) {
            if (!before.knownCanonical && !before.hasCanonicalEntity) {
            }
            return true;
        }

        if (EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelScope)) {
            return false;
        }

        EntityHandler.sendEntity(viewer, entity);
        const after = CombatHandler.getServerAuthorityViewerEntityState(viewer, canonicalId);
        const resolved = after.knownCanonical || after.hasCanonicalEntity || after.knownLocal || after.hasLocalEntity;
        return resolved;
    }

    private static syncServerAuthorityNpcViewerCache(viewer: Client, entity: any): {
        localId: number;
        previousHp: number;
        previousDead: boolean;
        previousEntState: number;
    } {
        const canonicalId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        const canonicalVisible = EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(getClientLevelScope(viewer));
        const localId = EntityHandler.resolveEntityLocalId(viewer, canonicalId);
        const targetId = localId > 0 ? localId : canonicalId;
        const existing = viewer.entities.get(targetId) ?? viewer.entities.get(canonicalId) ?? {};
        const previousHp = Math.round(Number(existing?.hp ?? NaN));
        const previousEntState = Math.round(Number(existing?.entState ?? EntityState.ACTIVE));
        const previousDead = Boolean(existing?.dead) || previousEntState === EntityState.DEAD;
        const keepClientProxy = canonicalVisible && Boolean(existing?.clientSpawned);
        viewer.entities.set(targetId, {
            ...existing,
            ...entity,
            id: targetId,
            clientSpawned: keepClientProxy || targetId !== canonicalId ? true : Boolean(entity.clientSpawned),
            sharedCanonicalId: targetId !== canonicalId ? canonicalId : existing?.sharedCanonicalId,
            canonicalEntityId: targetId !== canonicalId ? canonicalId : existing?.canonicalEntityId
        });
        viewer.knownEntityIds.add(canonicalId);
        return {
            localId: targetId,
            previousHp,
            previousDead,
            previousEntState
        };
    }

    private static sendServerAuthorityHpCorrection(
        viewer: Client,
        levelScope: string,
        entity: any,
        localEntityId: number,
        previousHp: number,
        expectedDamage: number,
        reason: string
    ): void {
        const canonicalHp = Math.max(0, Math.round(Number(entity?.hp ?? 0)));
        const maxHp = Math.max(0, Math.round(Number(entity?.maxHp ?? 0)));
        const previous = Number.isFinite(previousHp) ? Math.max(0, Math.round(previousHp)) : maxHp;
        const expectedPostPacketHp = Math.max(0, previous - Math.max(0, Math.round(expectedDamage)));
        const delta = canonicalHp - expectedPostPacketHp;
        if (delta === 0) {
            return;
        }
        viewer.send(
            CombatHandler.CLIENT_HEAL_PACKET_ID,
            CombatHandler.buildHpDeltaPayload(localEntityId, delta)
        );
    }

    private static sendAuthoritativeServerAuthorityHpToViewer(
        viewer: Client,
        levelScope: string,
        entity: any,
        localEntityId: number,
        reason: string,
        hpVersion: number
    ): boolean {
        const canonicalId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        const localId = Math.max(0, Math.round(Number(localEntityId) || 0));
        if (canonicalId <= 0 || localId <= 0) {
            return false;
        }

        const canonicalHp = Math.max(0, Math.round(Number(entity?.hp ?? 0)));
        const maxHp = Math.max(1, Math.round(Number(entity?.maxHp ?? 0)) || EntityHandler.estimateServerAuthorityHostileMaxHp(entity) || 1);
        const existing = viewer.entities.get(localId) ?? viewer.entities.get(canonicalId);
        const previousHpRaw = Number(existing?.hp ?? NaN);
        const previousHp = Number.isFinite(previousHpRaw)
            ? Math.max(0, Math.round(previousHpRaw))
            : maxHp;
        if (TutorialDungeonMechanics.isCompletionBoss(levelScope, entity)) {
            viewer.send(0x78, CombatHandler.buildHpDeltaPayload(localId, maxHp));
            const damageTaken = Math.max(0, maxHp - canonicalHp);
            if (damageTaken > 0) {
                viewer.send(0x78, CombatHandler.buildHpDeltaPayload(localId, -damageTaken));
            }
        } else {
            const delta = canonicalHp - previousHp;
            viewer.send(0x78, CombatHandler.buildHpDeltaPayload(localId, delta));
        }
        viewer.entities.set(localId, {
            ...(existing ?? {}),
            ...entity,
            id: localId,
            hp: canonicalHp,
            maxHp,
            healthDelta: canonicalHp - maxHp,
            health_delta: canonicalHp - maxHp,
            canonicalEntityId: localId === canonicalId ? undefined : canonicalId,
            sharedCanonicalId: localId === canonicalId ? undefined : canonicalId
        });
        viewer.knownEntityIds.add(localId);
        viewer.knownEntityIds.add(canonicalId);
        return true;
    }

    private static broadcastAuthoritativeServerAuthorityHp(
        anchor: Client,
        levelScope: string,
        entity: any,
        reason: string
    ): number {
        if (!CombatHandler.isServerAuthoritySyncNpc(levelScope, entity)) {
            return 0;
        }

        const canonicalId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        const hpVersion = Math.max(0, Math.round(Number(entity?.hpVersion ?? 0)));
        let count = 0;
        for (const viewer of GlobalState.sessionsByToken.values()) {
            if (!CombatHandler.canReceiveServerAuthorityNpcRelay(anchor, viewer, levelScope)) {
                continue;
            }

            const resolved = EntityHandler.resolveHostileLocalIdForViewer(viewer, levelScope, canonicalId, 'hp-broadcast-all');
            if (!resolved.ok || resolved.localId <= 0) {
                continue;
            }

            if (CombatHandler.sendAuthoritativeServerAuthorityHpToViewer(viewer, levelScope, entity, resolved.localId, reason, hpVersion)) {
                count++;
            }
        }

        if (TutorialDungeonMechanics.isCompletionBoss(levelScope, entity)) {
            for (const viewer of GlobalState.sessionsByToken.values()) {
                if (getClientLevelScope(viewer) === levelScope) {
                    EntityHandler.sendTutorialDungeonWorldSnapshot(viewer, reason);
                }
            }
        }

        return count;
    }

    private static sendHostileDeathCorrectionToViewer(
        viewer: Client,
        levelScope: string,
        canonicalEntity: any,
        localEntityId: number,
        reason: string
    ): boolean {
        const canonicalId = Math.max(0, Math.round(Number(canonicalEntity?.id ?? 0)));
        const localId = Math.max(0, Math.round(Number(localEntityId) || 0));
        if (canonicalId <= 0 || localId <= 0) {
            return false;
        }

        const maxHp = Math.max(1, Math.round(Number(canonicalEntity?.maxHp ?? 0)) || EntityHandler.estimateServerAuthorityHostileMaxHp(canonicalEntity) || 1);
        const existing = viewer.entities.get(localId) ?? viewer.entities.get(canonicalId);
        const previousHpRaw = Number(existing?.hp ?? NaN);
        const previousHp = Number.isFinite(previousHpRaw)
            ? Math.max(0, Math.round(previousHpRaw))
            : maxHp;
        viewer.send(0x78, CombatHandler.buildHpDeltaPayload(localId, -previousHp));
        viewer.send(0x07, CombatHandler.buildEntityStatePayload(localId, EntityState.DEAD, Boolean(canonicalEntity?.facingLeft)));
        viewer.send(0x0D, CombatHandler.buildDestroyEntityPayload(localId, true));
        viewer.entities.delete(localId);
        viewer.entities.delete(canonicalId);
        viewer.knownEntityIds.delete(localId);
        viewer.knownEntityIds.delete(canonicalId);
        return true;
    }

    private static convergeServerAuthorityNpcHealthToParty(
        anchor: Client,
        levelScope: string,
        entity: any,
        reason: string,
        rawEntityId: number = 0
    ): void {
        if (!CombatHandler.isServerAuthoritySyncNpc(levelScope, entity)) {
            return;
        }

        EntityHandler.normalizeServerAuthorityHostileState(levelScope, entity);
        const canonicalId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        if (CombatHandler.isCanonicalHostileTerminal(levelScope, entity)) {
            CombatHandler.relayServerAuthorityNpcDeath(anchor, levelScope, entity);
            return;
        }
        for (const viewer of GlobalState.sessionsByToken.values()) {
            if (!CombatHandler.canReceiveServerAuthorityNpcRelay(anchor, viewer, levelScope)) {
                continue;
            }
            if (!CombatHandler.ensureServerAuthorityNpcKnown(viewer, levelScope, entity, reason)) {
                continue;
            }

            const cacheState = CombatHandler.syncServerAuthorityNpcViewerCache(viewer, entity);
            CombatHandler.sendServerAuthorityHpCorrection(
                viewer,
                levelScope,
                entity,
                cacheState.localId,
                cacheState.previousHp,
                0,
                reason
            );
            if (
                Boolean(entity.dead) ||
                Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD ||
                Math.round(Number(entity.hp ?? 0)) <= 0
            ) {
                const deathPayload = CombatHandler.buildEntityStatePayload(cacheState.localId, EntityState.DEAD, Boolean(entity.facingLeft));
                viewer.send(0x07, deathPayload);
            }
        }
    }

    private static sendServerAuthorityAliveCorrection(
        viewer: Client,
        levelScope: string,
        entity: any,
        reason: string,
        rawEntityId: number = 0
    ): void {
        EntityHandler.normalizeServerAuthorityHostileState(levelScope, entity);
        if (CombatHandler.isCanonicalHostileTerminal(levelScope, entity)) {
            const canonicalId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
            const localId = rawEntityId > 0
                ? rawEntityId
                : EntityHandler.resolveHostileLocalIdForViewer(viewer, levelScope, canonicalId, 'alive-correction-converted-to-death').localId;
            CombatHandler.sendHostileDeathCorrectionToViewer(viewer, levelScope, entity, localId, reason);
            return;
        }
        if (!CombatHandler.ensureServerAuthorityNpcKnown(viewer, levelScope, entity, reason)) {
            return;
        }

        const cacheState = CombatHandler.syncServerAuthorityNpcViewerCache(viewer, entity);
        if (!Boolean(entity.dead) && Number(entity.entState ?? EntityState.ACTIVE) !== EntityState.DEAD) {
            const activePayload = CombatHandler.buildEntityStatePayload(
                cacheState.localId,
                Number(entity.entState ?? EntityState.ACTIVE),
                Boolean(entity.facingLeft)
            );
            viewer.send(0x07, activePayload);
        }
        CombatHandler.sendServerAuthorityHpCorrection(viewer, levelScope, entity, cacheState.localId, cacheState.previousHp, 0, reason);
    }

    static correctServerAuthorityHostileProxy(
        viewer: Client,
        levelScope: string,
        entity: any,
        reason: string,
        rawEntityId: number = 0
    ): void {
        if (!CombatHandler.isServerAuthoritySyncNpc(levelScope, entity)) {
            return;
        }

        if (CombatHandler.isCanonicalHostileTerminal(levelScope, entity)) {
            CombatHandler.relayServerAuthorityNpcDeath(viewer, levelScope, entity);
            return;
        }

        CombatHandler.sendServerAuthorityAliveCorrection(viewer, levelScope, entity, reason, rawEntityId);
    }

    private static snapshotServerAuthorityNpcViewerHealth(
        anchor: Client,
        levelScope: string,
        entity: any
    ): Map<number, HostileViewerHealthSnapshot> {
        const snapshots = new Map<number, HostileViewerHealthSnapshot>();
        if (!CombatHandler.isServerAuthoritySyncNpc(levelScope, entity)) {
            return snapshots;
        }

        const canonicalId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        if (canonicalId <= 0) {
            return snapshots;
        }

        for (const viewer of GlobalState.sessionsByToken.values()) {
            if (!CombatHandler.canReceiveServerAuthorityNpcRelay(anchor, viewer, levelScope)) {
                continue;
            }

            const canonicalVisible = EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelScope);
            const resolvedLocalId = EntityHandler.resolveEntityLocalId(viewer, canonicalId);
            const localId = canonicalVisible ? canonicalId : (resolvedLocalId > 0 ? resolvedLocalId : canonicalId);
            const existing =
                viewer.entities.get(localId) ??
                viewer.entities.get(canonicalId) ??
                entity;
            snapshots.set(viewer.token, {
                localId,
                previousHp: Math.round(Number(existing?.hp ?? entity?.hp ?? NaN)),
                previousMaxHp: Math.max(0, Math.round(Number(existing?.maxHp ?? entity?.maxHp ?? 0)))
            });
        }

        return snapshots;
    }

    private static relayServerAuthorityNpcHit(
        anchor: Client,
        levelScope: string,
        entity: any,
        payload: Buffer,
        referencedEntityIds: number[],
        appliedDamage: number,
        sourceId: number,
        preHitSnapshots: Map<number, HostileViewerHealthSnapshot> = new Map<number, HostileViewerHealthSnapshot>()
    ): boolean {
        if (!CombatHandler.isServerAuthoritySyncNpc(levelScope, entity)) {
            return false;
        }

        EntityHandler.normalizeServerAuthorityHostileState(levelScope, entity);
        const canonicalId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        const viewers: string[] = [];
        const hitViewers: string[] = [];
        for (const viewer of GlobalState.sessionsByToken.values()) {
            if (!CombatHandler.canReceiveServerAuthorityNpcRelay(anchor, viewer, levelScope)) {
                continue;
            }

            let missingTargetRef = false;
            for (const refId of referencedEntityIds) {
                const canonicalRefId = Math.max(0, Math.round(Number(refId) || 0));
                if (canonicalRefId <= 0) {
                    continue;
                }
                const refEntity = CombatHandler.resolveLevelEntity(levelScope, canonicalRefId);
                const refKnown = refEntity && CombatHandler.isServerAuthoritySyncNpc(levelScope, refEntity)
                    ? CombatHandler.ensureServerAuthorityNpcKnown(viewer, levelScope, refEntity, 'hit_target_snapshot')
                    : CombatHandler.canViewerResolveCombatEntity(viewer, levelScope, canonicalRefId);
                if (!refKnown) {
                    if (canonicalRefId === canonicalId) {
                        missingTargetRef = true;
                    }
                }
            }
            if (missingTargetRef) {
                continue;
            }

            const cacheState = CombatHandler.syncServerAuthorityNpcViewerCache(viewer, entity);
            const preHitSnapshot = preHitSnapshots.get(viewer.token);
            const previousHpForCorrection = Number.isFinite(preHitSnapshot?.previousHp)
                ? Math.max(0, Math.round(Number(preHitSnapshot?.previousHp)))
                : cacheState.previousHp;
            if (
                cacheState.previousDead &&
                !Boolean(entity.dead) &&
                Number(entity.entState ?? EntityState.ACTIVE) !== EntityState.DEAD
            ) {
                viewer.send(
                    0x07,
                    CombatHandler.buildEntityStatePayload(cacheState.localId, Number(entity.entState ?? EntityState.ACTIVE), Boolean(entity.facingLeft))
                );
            }

            const isSourceViewer = viewer === anchor;
            if (isSourceViewer) {
                CombatHandler.sendServerAuthorityHpCorrection(
                    viewer,
                    levelScope,
                    entity,
                    cacheState.localId,
                    previousHpForCorrection,
                    appliedDamage,
                    'post_hit_converge'
                );
            } else {
                const previousHp = Number.isFinite(previousHpForCorrection) ? Math.max(0, Math.round(previousHpForCorrection)) : 0;
                const canonicalHp = Math.max(0, Math.round(Number(entity.hp ?? 0)));
                const canonicalDead = Boolean(entity.dead) ||
                    Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD ||
                    canonicalHp <= 0;
                if (previousHp > canonicalHp) {
                    CombatHandler.sendServerAuthorityHpCorrection(
                        viewer,
                        levelScope,
                        entity,
                        cacheState.localId,
                        previousHpForCorrection,
                        0,
                        canonicalDead ? 'post_lethal_viewer_converge' : 'post_hit_viewer_converge'
                    );
                } else if (previousHp < canonicalHp) {
                    CombatHandler.sendServerAuthorityHpCorrection(
                        viewer,
                        levelScope,
                        entity,
                        cacheState.localId,
                        previousHpForCorrection,
                        0,
                        'post_hit_positive_converge'
                    );
                }
            }
            viewers.push(String(viewer.character?.name ?? viewer.token));
        }
        return viewers.length > 0;
    }

    private static relayServerAuthorityNpcDeath(anchor: Client, levelScope: string, entity: any): void {
        if (!CombatHandler.isServerAuthoritySyncNpc(levelScope, entity)) {
            return;
        }

        EntityHandler.normalizeServerAuthorityHostileState(levelScope, entity);
        const entityId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        const maxHp = Math.max(1, Math.round(Number(entity.maxHp ?? EntityHandler.estimateServerAuthorityHostileMaxHp(entity))));
        CombatHandler.finalizeHostileDeath(anchor, levelScope, entityId, entity, {
            includeAnchor: true,
            reason: 'server_authority_hostile_death'
        });
        entity.level = EntityHandler.SERVER_AUTHORITY_ENTITY_LEVEL;
        entity.maxHp = maxHp;
        entity.hp = 0;
        entity.dead = true;
        entity.entState = EntityState.DEAD;
        entity.healthDelta = -maxHp;
        entity.health_delta = -maxHp;

        const viewers: string[] = [];
        for (const viewer of GlobalState.sessionsByToken.values()) {
            if (!CombatHandler.canReceiveServerAuthorityNpcRelay(anchor, viewer, levelScope)) {
                continue;
            }
            viewers.push(String(viewer.character?.name ?? viewer.token));
        }
        CombatHandler.refreshServerAuthorityProgressWithRetries(levelScope, 'authoritative_death_relay');
    }

    private static broadcastServerAuthorityNpcDestroy(
        anchor: Client,
        levelScope: string,
        entityId: number,
        destroyedEntity: any,
        immediate: boolean = true
    ): void {
        if (!CombatHandler.isServerAuthoritySyncNpc(levelScope, destroyedEntity)) {
            return;
        }

        const viewers: Array<{ name: string; token: number; localEntityId: number }> = [];
        for (const viewer of GlobalState.sessionsByToken.values()) {
            if (!CombatHandler.canReceiveServerAuthorityNpcRelay(anchor, viewer, levelScope)) {
                continue;
            }

            const localEntityId = EntityHandler.resolveEntityLocalId(viewer, entityId);
            viewer.send(0x0D, CombatHandler.buildDestroyEntityPayload(localEntityId, immediate));
            viewer.entities.delete(localEntityId);
            viewer.entities.delete(entityId);
            viewer.knownEntityIds.delete(localEntityId);
            viewer.knownEntityIds.delete(entityId);
            viewers.push({
                name: String(viewer.character?.name ?? viewer.token),
                token: viewer.token,
                localEntityId
            });
        }
    }

    private static broadcastToSameLevel(
        levelScope: string,
        packetId: number,
        data: Buffer,
        referencedEntityIds: number[] = [],
        excludedClient: Client | null = null
    ): void {
        if (!levelScope) {
            return;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== levelScope || other === excludedClient) {
                continue;
            }

            let missingEntity = false;
            for (const entityId of referencedEntityIds) {
                if (!CombatHandler.canViewerResolveCombatEntity(other, levelScope, entityId)) {
                    missingEntity = true;
                    break;
                }
            }
            if (missingEntity) {
                continue;
            }

            CombatHandler.sendTranslatedPacket(other, packetId, data);
        }
    }

    static broadcastEntityViewPacket(
        levelScope: string,
        sourceEntity: any,
        packetId: number,
        data: Buffer,
        referencedEntityIds: number[] = [],
        excludedClient: Client | null = null
    ): void {
        if (!levelScope) {
            return;
        }

        const sourceRoomId = Number.isFinite(Number(sourceEntity?.roomId)) ? Number(sourceEntity.roomId) : -1;
        const partySharedSource = CombatHandler.shouldMirrorClientSpawnEntityToParty(getScopeLevelName(levelScope), sourceEntity);
        const dedupedRefs = Array.from(new Set(referencedEntityIds.filter((id) => Number.isFinite(id) && id > 0)));

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== levelScope || other === excludedClient) {
                continue;
            }
            if (sourceRoomId >= 0 && !partySharedSource && !sharesRoomIds(other.currentRoomId, sourceRoomId)) {
                continue;
            }

            let missingEntity = false;
            for (const entityId of dedupedRefs) {
                if (!CombatHandler.canViewerResolveCombatEntity(other, levelScope, entityId)) {
                    missingEntity = true;
                    break;
                }
            }
            if (missingEntity) {
                continue;
            }

            CombatHandler.sendTranslatedPacket(other, packetId, data);
        }
    }

    static broadcastToCombatRoom(anchor: Client, packetId: number, data: Buffer, includeAnchor: boolean = false, referencedEntityIds: number[] = []): void {
        const levelScope = getClientLevelScope(anchor);
        if (!levelScope || !anchor.playerSpawned) {
            return;
        }

        for (const other of CombatHandler.getCombatRecipients(anchor, includeAnchor)) {
            let missingEntity = false;
            for (const entityId of referencedEntityIds) {
                if (!CombatHandler.canViewerResolveAnchoredCombatEntity(other, anchor, levelScope, entityId)) {
                    missingEntity = true;
                    break;
                }
            }
            if (missingEntity) {
                continue;
            }

            CombatHandler.sendTranslatedPacket(other, packetId, data);
        }
    }

    private static broadcastCombatPacket(anchor: Client, packetId: number, data: Buffer, options: CombatRelayOptions = {}): void {
        const referencedEntityIds = Array.from(new Set((options.referencedEntityIds ?? []).filter((id) => Number.isFinite(id) && id > 0)));
        CombatHandler.broadcastToCombatRoom(anchor, packetId, data, Boolean(options.includeAnchor), referencedEntityIds);
    }

    private static canViewerResolveCombatEntity(viewer: Client, levelScope: string, entityId: number): boolean {
        if (entityId <= 0) {
            return true;
        }

        const localEntityId = EntityHandler.resolveEntityLocalId(viewer, entityId);
        if (
            localEntityId !== entityId &&
            (viewer.entities.has(localEntityId) || viewer.knownEntityIds.has(localEntityId))
        ) {
            return true;
        }

        const entity = GlobalState.levelEntities.get(levelScope)?.get(entityId);
        if (!entity) {
            return false;
        }

        if (
            EntityHandler.isServerAuthorityHostileEntity(viewer.currentLevel, entity) &&
            EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(viewer.currentLevel)
        ) {
            return EntityHandler.canClientResolveCanonicalEntity(viewer, entityId);
        }

        if (EntityHandler.shouldTrackKnownEntity(viewer.currentLevel, entity)) {
            return EntityHandler.ensureEntityKnown(viewer, viewer.currentLevel, entityId);
        }

        if (CombatHandler.shouldMirrorClientSpawnEntityToParty(viewer.currentLevel, entity)) {
            return true;
        }

        const isRoomScopedClientNpc = Boolean(
            !entity.isPlayer &&
            entity.clientSpawned &&
            sharesRoomIds(viewer.currentRoomId, Number(entity.roomId ?? -1))
        );
        return isRoomScopedClientNpc;
    }

    private static broadcastPlayerHpDelta(targetSession: Client, delta: number, includeTarget: boolean = true): void {
        if (!targetSession.playerSpawned || !targetSession.currentLevel || targetSession.clientEntID <= 0 || delta === 0) {
            return;
        }

        const payload = CombatHandler.buildHpDeltaPayload(targetSession.clientEntID, delta);
        CombatHandler.broadcastToCombatRoom(targetSession, CombatHandler.CLIENT_HEAL_PACKET_ID, payload, includeTarget, [targetSession.clientEntID]);
    }

    private static broadcastPlayerState(targetSession: Client, entState: number, roomScoped: boolean = false): void {
        if (!targetSession.playerSpawned || !targetSession.currentLevel || targetSession.clientEntID <= 0) {
            return;
        }

        const entity = targetSession.entities.get(targetSession.clientEntID) ??
            CombatHandler.resolveLevelEntity(getClientLevelScope(targetSession), targetSession.clientEntID);
        const facingLeft = Boolean(entity?.facingLeft);
        const payload = CombatHandler.buildEntityStatePayload(targetSession.clientEntID, entState, facingLeft);
        if (roomScoped) {
            const levelScope = getClientLevelScope(targetSession);
            for (const other of GlobalState.sessionsByToken.values()) {
                if (
                    other === targetSession ||
                    !other.playerSpawned ||
                    getClientLevelScope(other) !== levelScope ||
                    !sharesRoomIds(other.currentRoomId, targetSession.currentRoomId) ||
                    !CombatHandler.canViewerResolveAnchoredCombatEntity(other, targetSession, levelScope, targetSession.clientEntID)
                ) {
                    continue;
                }

                CombatHandler.sendTranslatedPacket(other, 0x07, payload);
            }
            return;
        }

        CombatHandler.broadcastToCombatRoom(targetSession, 0x07, payload, false, [targetSession.clientEntID]);
    }

    private static getEntityPosition(entity: any): CombatPoint | null {
        if (!entity || typeof entity !== 'object') {
            return null;
        }

        const x = Number(entity.physPosX ?? entity.x ?? entity.var_10 ?? NaN);
        const y = Number(entity.physPosY ?? entity.y ?? entity.var_12 ?? NaN);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return null;
        }

        return {
            x,
            y
        };
    }

    private static getPlayerCombatPosition(client: Client, levelScope: string): CombatPoint | null {
        const currentLevel = client.character?.CurrentLevel;
        const currentX = Number(currentLevel?.x ?? NaN);
        const currentY = Number(currentLevel?.y ?? NaN);
        if (Number.isFinite(currentX) && Number.isFinite(currentY)) {
            return {
                x: currentX,
                y: currentY
            };
        }

        const entityId = Math.max(0, Math.round(Number(client.clientEntID ?? 0)));
        const localEntity = entityId > 0 && typeof client.entities?.get === 'function'
            ? client.entities.get(entityId)
            : null;
        return CombatHandler.getEntityPosition(localEntity) ??
            CombatHandler.getEntityPosition(CombatHandler.resolveLevelEntity(levelScope, entityId));
    }

    private static isPlayerInBossAggro(levelScope: string, entity: any, session: Client): boolean {
        const bossPos = CombatHandler.getEntityPosition(entity);
        if (!bossPos) {
            return false;
        }

        const bossRoomId = Number.isFinite(Number(entity?.roomId)) ? Math.round(Number(entity.roomId)) : -1;
        const playerRoomId = Number.isFinite(Number(session.currentRoomId)) ? Math.round(Number(session.currentRoomId)) : -1;
        if (bossRoomId < 0 || playerRoomId < 0 || bossRoomId !== playerRoomId) {
            return false;
        }

        const playerPos = CombatHandler.getPlayerCombatPosition(session, levelScope);
        if (!playerPos) {
            return false;
        }

        const aggroRadius = CombatHandler.getBossAggroRadius(entity);
        return Math.hypot(playerPos.x - bossPos.x, playerPos.y - bossPos.y) <= aggroRadius;
    }

    private static hasLivePlayerInBossAggro(levelScope: string, entity: any): boolean {
        for (const session of GlobalState.sessionsByToken.values()) {
            if (!session.playerSpawned || getClientLevelScope(session) !== levelScope || !session.character) {
                continue;
            }
            if (CombatHandler.isPlayerDeadForCombat(session, levelScope)) {
                continue;
            }

            if (CombatHandler.isPlayerInBossAggro(levelScope, entity, session)) {
                return true;
            }
        }

        return false;
    }

    private static getEntityPierceRadius(entity: any): number {
        const width = Math.max(0, Number(entity?.width ?? entity?.entType?.width ?? 0));
        const height = Math.max(0, Number(entity?.height ?? entity?.entType?.height ?? 0));
        return Math.max(CombatHandler.FIREBRAND_PIERCING_SHOT_MIN_HIT_RADIUS, width * 0.5, height * 0.35);
    }

    private static isFireBrandPiercingTarget(entity: any): boolean {
        return Boolean(entity) &&
            !Boolean(entity?.isPlayer) &&
            (
                Number(entity?.team ?? 0) === EntityTeam.ENEMY ||
                EntityHandler.isHomeDummyEntity(entity)
            );
    }

    private static collectFireBrandPiercingTargetsOnLine(
        levelScope: string,
        sourceEntity: any,
        targetPos: CombatPoint | null
    ): any[] {
        const sourcePos = CombatHandler.getEntityPosition(sourceEntity);
        if (!levelScope || !sourcePos || !targetPos) {
            return [];
        }

        const dx = targetPos.x - sourcePos.x;
        const dy = targetPos.y - sourcePos.y;
        const distance = Math.hypot(dx, dy);
        if (distance <= 0) {
            return [];
        }

        const unitX = dx / distance;
        const unitY = dy / distance;
        const sourceId = Number(sourceEntity?.id ?? 0);
        const sourceRoomId = Number.isFinite(Number(sourceEntity?.roomId)) ? Number(sourceEntity.roomId) : -1;
        const targets: Array<{ entity: any; projection: number }> = [];

        for (const candidate of GlobalState.levelEntities.get(levelScope)?.values() ?? []) {
            const candidateId = Number(candidate?.id ?? 0);
            if (candidateId <= 0 || candidateId === sourceId) {
                continue;
            }
            if (!CombatHandler.isFireBrandPiercingTarget(candidate)) {
                continue;
            }
            if (Boolean(candidate?.dead) || Number(candidate?.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
                continue;
            }
            if (Boolean(candidate?.untargetable)) {
                continue;
            }
            if (sourceRoomId >= 0 && !sharesRoomIds(sourceRoomId, Number(candidate?.roomId ?? -1))) {
                continue;
            }

            const candidatePos = CombatHandler.getEntityPosition(candidate);
            if (!candidatePos) {
                continue;
            }

            const relX = candidatePos.x - sourcePos.x;
            const relY = candidatePos.y - sourcePos.y;
            const projection = relX * unitX + relY * unitY;
            if (projection <= 0 || projection > CombatHandler.FIREBRAND_PIERCING_SHOT_RANGE) {
                continue;
            }

            const closestX = sourcePos.x + unitX * projection;
            const closestY = sourcePos.y + unitY * projection;
            const perpendicularDistance = Math.hypot(candidatePos.x - closestX, candidatePos.y - closestY);
            if (perpendicularDistance <= CombatHandler.getEntityPierceRadius(candidate)) {
                targets.push({ entity: candidate, projection });
            }
        }

        targets.sort((left, right) => left.projection - right.projection);
        return targets.map((target) => target.entity);
    }

    private static getFireBrandPiercingCastKey(levelScope: string, sourceId: number): string {
        return `${levelScope}:${sourceId}:${CombatHandler.FIREBRAND_PIERCING_SHOT_POWER_ID}`;
    }

    private static markFireBrandPiercingCastDamage(levelScope: string, sourceId: number): void {
        CombatHandler.recentFireBrandPiercingCasts.set(
            CombatHandler.getFireBrandPiercingCastKey(levelScope, sourceId),
            Date.now()
        );
    }

    private static didRecentlyApplyFireBrandPiercingCastDamage(levelScope: string, sourceId: number): boolean {
        const key = CombatHandler.getFireBrandPiercingCastKey(levelScope, sourceId);
        const appliedAt = Number(CombatHandler.recentFireBrandPiercingCasts.get(key) ?? 0);
        if (appliedAt <= 0) {
            return false;
        }

        if (Date.now() - appliedAt > CombatHandler.FIREBRAND_PIERCING_HIT_DEDUPE_MS) {
            CombatHandler.recentFireBrandPiercingCasts.delete(key);
            return false;
        }

        return true;
    }

    private static getFireBrandThirdShotHitKey(levelScope: string, sourceId: number, targetId: number): string {
        return `${levelScope}:${sourceId}:${targetId}:${CombatHandler.FIREBRAND_THIRD_SHOT_POWER_ID}`;
    }

    private static shouldSuppressDuplicateFireBrandThirdShotHit(info: PowerHitRelayInfo, levelScope: string): boolean {
        if (info.powerId !== CombatHandler.FIREBRAND_THIRD_SHOT_POWER_ID || info.sourceId <= 0 || info.targetId <= 0) {
            return false;
        }

        const now = Date.now();
        const key = CombatHandler.getFireBrandThirdShotHitKey(levelScope, info.sourceId, info.targetId);
        const lastHitAt = Number(CombatHandler.recentFireBrandThirdShotHits.get(key) ?? 0);
        if (lastHitAt > 0 && now - lastHitAt <= CombatHandler.FIREBRAND_THIRD_SHOT_HIT_DEDUPE_MS) {
            CombatHandler.recentFireBrandThirdShotHits.set(key, now);
            return true;
        }

        CombatHandler.recentFireBrandThirdShotHits.set(key, now);
        for (const [hitKey, hitAt] of CombatHandler.recentFireBrandThirdShotHits) {
            if (now - Number(hitAt) > CombatHandler.FIREBRAND_THIRD_SHOT_HIT_DEDUPE_MS) {
                CombatHandler.recentFireBrandThirdShotHits.delete(hitKey);
            }
        }
        return false;
    }

    private static resolveFireBrandPiercingShotDamage(sourceSession: Client, sourceEntity: any): number {
        const localSource = sourceSession.clientEntID > 0 ? sourceSession.entities.get(sourceSession.clientEntID) : null;
        const rawDamage = Math.max(
            0,
            Number(sourceEntity?.magicDamage ?? 0),
            Number(localSource?.magicDamage ?? 0),
            Number(sourceEntity?.meleeDamage ?? 0),
            Number(localSource?.meleeDamage ?? 0)
        );
        if (Number.isFinite(rawDamage) && rawDamage > 0) {
            return Math.max(1, Math.round(rawDamage));
        }

        return 25;
    }

    private static resolveFireBrandPiercingTargetPos(info: PowerCastRelayInfo, sourceEntity: any): CombatPoint | null {
        if (info.targetPos) {
            return info.targetPos;
        }

        const sourcePos = CombatHandler.getEntityPosition(sourceEntity);
        if (!sourcePos) {
            return null;
        }

        const facingLeft = Boolean(sourceEntity?.facingLeft ?? sourceEntity?.facing_left ?? false);
        return {
            x: sourcePos.x + (facingLeft ? -CombatHandler.FIREBRAND_PIERCING_SHOT_RANGE : CombatHandler.FIREBRAND_PIERCING_SHOT_RANGE),
            y: sourcePos.y
        };
    }

    private static applyFireBrandPiercingCastDamage(
        client: Client,
        levelScope: string,
        info: PowerCastRelayInfo,
        sourceSession: Client | null,
        sourceEntity: any
    ): void {
        if (
            info.powerId !== CombatHandler.FIREBRAND_PIERCING_SHOT_POWER_ID ||
            !sourceSession ||
            !sourceEntity
        ) {
            return;
        }

        const targetPos = CombatHandler.resolveFireBrandPiercingTargetPos(info, sourceEntity);
        let targets = CombatHandler.collectFireBrandPiercingTargetsOnLine(levelScope, sourceEntity, targetPos);
        if (targets.length === 0 && info.targetPos) {
            targets = CombatHandler.collectFireBrandPiercingTargetsOnLine(
                levelScope,
                sourceEntity,
                CombatHandler.resolveFireBrandPiercingTargetPos({ ...info, targetPos: null }, sourceEntity)
            );
        }
        if (targets.length === 0) {
            return;
        }

        const damage = CombatHandler.resolveFireBrandPiercingShotDamage(sourceSession, sourceEntity);
        CombatHandler.markFireBrandPiercingCastDamage(levelScope, info.sourceId);
        for (const targetEntity of targets) {
            const targetId = Number(targetEntity?.id ?? 0);
            if (targetId <= 0) {
                continue;
            }

            CombatHandler.noteCombatInteraction(levelScope, info.sourceId, targetId, client);
            CombatHandler.maybeRecordNpcContribution(levelScope, targetId, info.sourceId, damage, client);
            noteDungeonRunHit(sourceSession, {
                sourceId: info.sourceId,
                targetId,
                targetEntity,
                damage
            });

            const deferDungeonCompletionUntilDestroy = Boolean(
                MissionHandler.shouldProcessEnemyKillStateDungeonCompletion(client, targetEntity)
            );
            CombatHandler.assignPartySharedHostileCombatAuthority(levelScope, targetEntity, sourceSession);
            const resolution = CombatHandler.updateNpcTargetAfterHit(levelScope, targetId, damage);
            if (resolution.entity) {
                TutorialDungeonMechanics.noteBossHealth(sourceSession, resolution.entity);
            }
            if (resolution.killed && resolution.entity && !deferDungeonCompletionUntilDestroy) {
                CombatHandler.handleEnemyDefeatState(sourceSession, levelScope, targetId, resolution.entity);
            }

            const relayInfo: PowerHitRelayInfo = {
                targetId,
                sourceId: info.sourceId,
                damage,
                powerId: info.powerId,
                animOverrideId: null,
                effectOverrideId: null,
                isCrit: false
            };
            CombatHandler.broadcastCombatPacket(
                client,
                0x0A,
                CombatHandler.buildPowerHitPayload(relayInfo, damage),
                {
                    includeAnchor: true,
                    referencedEntityIds: [targetId, info.sourceId]
                }
            );
        }
    }

    private static resolvePowerCastSourceEntity(levelScope: string, sourceId: number, fallbackClient: Client): any {
        if (sourceId <= 0) {
            return null;
        }

        const levelEntity = CombatHandler.resolveLevelEntity(levelScope, sourceId);
        if (levelEntity) {
            return levelEntity;
        }

        if (fallbackClient.clientEntID === sourceId) {
            return fallbackClient.entities.get(sourceId) ?? null;
        }

        return CombatHandler.findPlayerSessionByEntityId(sourceId)?.entities.get(sourceId) ?? null;
    }

    private static findSyntheticPowerCastTargetPos(levelScope: string, sourceEntity: any): CombatPoint | null {
        const sourcePos = CombatHandler.getEntityPosition(sourceEntity);
        if (!sourcePos) {
            return null;
        }

        const levelMap = GlobalState.levelEntities.get(levelScope);
        const sourceId = Number(sourceEntity?.id ?? 0);
        const sourceTeam = Number(sourceEntity?.team ?? 0);
        const sourceRoomId = Number.isFinite(Number(sourceEntity?.roomId)) ? Number(sourceEntity.roomId) : -1;
        const facingLeft = Boolean(sourceEntity?.facingLeft);

        let bestFacingTarget: { pos: CombatPoint; distanceSq: number } | null = null;
        let bestAnyTarget: { pos: CombatPoint; distanceSq: number } | null = null;

        for (const candidate of levelMap?.values() ?? []) {
            const candidateId = Number(candidate?.id ?? 0);
            if (candidateId <= 0 || candidateId === sourceId) {
                continue;
            }
            if (Boolean(candidate?.dead) || Number(candidate?.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
                continue;
            }
            if (Boolean(candidate?.untargetable)) {
                continue;
            }

            const candidateTeam = Number(candidate?.team ?? 0);
            if (sourceTeam > 0 && candidateTeam > 0 && sourceTeam === candidateTeam) {
                continue;
            }
            if (sourceRoomId >= 0 && !sharesRoomIds(sourceRoomId, Number(candidate?.roomId ?? -1))) {
                continue;
            }

            const candidatePos = CombatHandler.getEntityPosition(candidate);
            if (!candidatePos) {
                continue;
            }

            const dx = candidatePos.x - sourcePos.x;
            const dy = candidatePos.y - sourcePos.y;
            const distanceSq = dx * dx + dy * dy;
            if (distanceSq > 500 * 500) {
                continue;
            }

            if (!bestAnyTarget || distanceSq < bestAnyTarget.distanceSq) {
                bestAnyTarget = { pos: candidatePos, distanceSq };
            }

            const isFacingTarget = facingLeft ? dx <= 60 : dx >= -60;
            if (isFacingTarget && (!bestFacingTarget || distanceSq < bestFacingTarget.distanceSq)) {
                bestFacingTarget = { pos: candidatePos, distanceSq };
            }
        }

        if (bestFacingTarget) {
            return bestFacingTarget.pos;
        }
        if (bestAnyTarget) {
            return bestAnyTarget.pos;
        }

        return {
            x: sourcePos.x + (facingLeft ? -220 : 220),
            y: sourcePos.y
        };
    }

    private static normalizePowerCastRelay(client: Client, info: PowerCastRelayInfo, data: Buffer): Buffer | null {
        if (!info.hasTargetEntity) {
            return data;
        }

        if (CombatHandler.UNSAFE_REMOTE_DIRECT_TARGET_POWER_IDS.has(info.powerId)) {
            return null;
        }

        if (info.hasTargetPos) {
            return data;
        }

        const levelScope = getClientLevelScope(client);
        if (!levelScope) {
            return null;
        }

        const sourceEntity = CombatHandler.resolvePowerCastSourceEntity(levelScope, info.sourceId, client);
        const targetPos = CombatHandler.findSyntheticPowerCastTargetPos(levelScope, sourceEntity);
        if (!targetPos) {
            return null;
        }

        return CombatHandler.buildPowerCastPayload({
            ...info,
            hasTargetPos: true,
            targetPos
        });
    }

    private static parsePowerCastRelayInfo(data: Buffer): PowerCastRelayInfo | null {
        const br = new BitReader(data);

        try {
            const sourceId = br.readMethod4();
            const powerId = br.readMethod4();
            const hasTargetEntity = br.readMethod15();
            const hasTargetPos = br.readMethod15();
            const targetPos = hasTargetPos
                ? {
                    x: br.readMethod24(),
                    y: br.readMethod24()
                }
                : null;
            const projectileId = br.readMethod15() ? br.readMethod4() : null;
            const isPersistent = br.readMethod15();
            const comboData = br.readMethod15()
                ? {
                    isMelee: br.readMethod15(),
                    id: br.readMethod4()
                }
                : null;

            return {
                sourceId,
                powerId,
                hasTargetEntity,
                hasTargetPos,
                targetPos,
                projectileId,
                isPersistent,
                comboData
            };
        } catch {
            return null;
        }
    }

    private static parsePowerHitRelayInfo(data: Buffer): PowerHitRelayInfo | null {
        const br = new BitReader(data);

        try {
            const targetId = br.readMethod9();
            const sourceId = br.readMethod9();
            const damage = Math.max(0, Math.round(br.readMethod24()));
            const powerId = br.readMethod9();
            const animOverrideId = br.readMethod15() ? br.readMethod9() : null;
            const effectOverrideId = br.readMethod15() ? br.readMethod9() : null;
            const isCrit = br.readMethod15();

            return {
                targetId,
                sourceId,
                damage,
                powerId,
                animOverrideId,
                effectOverrideId,
                isCrit
            };
        } catch {
            return null;
        }
    }

    private static parseBuffTickDotInfo(data: Buffer): BuffTickDotInfo | null {
        const br = new BitReader(data);

        try {
            const targetId = br.readMethod9();
            const sourceId = br.readMethod9();
            const powerId = br.readMethod9();
            const rawDamage = br.readMethod45();
            const damage = Math.max(0, Math.round(Math.abs(rawDamage)));
            const tailBits = br.readMethod20(5);

            return {
                targetId,
                sourceId,
                powerId,
                damage,
                rawDamage,
                tailBits
            };
        } catch {
            return null;
        }
    }

    private static updatePlayerTargetAfterHit(targetSession: Client, damage: number, preventDeath: boolean = false): PlayerHitResolution {
        if (damage <= 0 || !targetSession.character || targetSession.clientEntID <= 0) {
            return {
                appliedDamage: 0,
                killed: false
            };
        }

        const entity = targetSession.entities.get(targetSession.clientEntID) ?? {};
        const levelEntity = CombatHandler.resolveLevelEntity(getClientLevelScope(targetSession), targetSession.clientEntID);
        if (CombatHandler.isEntityDead(entity) || CombatHandler.isEntityDead(levelEntity)) {
            return {
                appliedDamage: 0,
                killed: true
            };
        }

        const knownMaxHp = CombatHandler.resolvePlayerMaxHp(targetSession, entity, levelEntity);
        const currentHp = CombatHandler.resolvePlayerCurrentHp(targetSession, entity, levelEntity, knownMaxHp);
        if (currentHp <= 0) {
            return {
                appliedDamage: 0,
                killed: Boolean(entity.dead)
            };
        }

        const requestedDamage = Math.max(0, Math.round(damage));
        const minHpAfterHit = preventDeath ? 1 : 0;
        const appliedDamage = Math.max(0, Math.min(requestedDamage, currentHp - minHpAfterHit));
        const nextHp = Math.max(minHpAfterHit, currentHp - appliedDamage);

        entity.maxHp = knownMaxHp;
        entity.hp = nextHp;
        entity.dead = nextHp <= 0;
        entity.entState = nextHp <= 0 ? EntityState.DEAD : EntityState.ACTIVE;
        targetSession.entities.set(targetSession.clientEntID, entity);

        if (levelEntity && typeof levelEntity === 'object') {
            levelEntity.maxHp = knownMaxHp;
            levelEntity.hp = nextHp;
            levelEntity.dead = entity.dead;
            levelEntity.entState = entity.entState;
        }

        targetSession.authoritativeMaxHp = knownMaxHp;
        targetSession.authoritativeCurrentHp = nextHp;
        return {
            appliedDamage,
            killed: entity.dead
        };
    }

    private static updateNpcTargetAfterHit(levelName: string, targetId: number, damage: number): NpcHitResolution {
        if (!levelName || targetId <= 0 || damage <= 0) {
            return {
                entity: null,
                entityId: targetId,
                appliedDamage: 0,
                killed: false
            };
        }

        const entity = CombatHandler.resolveLevelEntity(levelName, targetId);
        if (!entity || entity.isPlayer) {
            return {
                entity: null,
                entityId: targetId,
                appliedDamage: 0,
                killed: false
            };
        }

        if (CombatHandler.isTerminalHostileEntity(entity)) {
            return {
                entity,
                entityId: targetId,
                appliedDamage: 0,
                killed: true
            };
        }

        if (EntityHandler.isServerAuthorityHostileEntity(levelName, entity)) {
            EntityHandler.normalizeServerAuthorityHostileState(levelName, entity);
        }

        const healthState = CombatHandler.isDungeonBossEntity(levelName, entity)
            ? CombatHandler.resolveHostileHealthStateAcrossCopies(levelName, entity)
            : CombatHandler.getNpcHealthState(entity);
        if (!healthState) {
            return {
                entity,
                entityId: targetId,
                appliedDamage: 0,
                killed: false
            };
        }

        const wasAlive = !Boolean(entity.dead) &&
            Number(entity.entState ?? EntityState.ACTIVE) !== EntityState.DEAD &&
            healthState.currentHp > 0;
        const isPartySharedHostile =
            CombatHandler.shouldMirrorClientSpawnEntityToParty(getScopeLevelName(levelName), entity);
        const authoritativeKill =
            (healthState.authoritativeKill || isPartySharedHostile) &&
            !CombatHandler.shouldDeferPowerHitKillToClient(levelName, entity);
        const requestedDamage = Math.max(0, Math.round(damage));
        const minHpAfterHit = authoritativeKill ? 0 : 1;
        const appliedDamage = Math.max(0, Math.min(requestedDamage, healthState.currentHp - minHpAfterHit));
        const nextHp = Math.max(minHpAfterHit, healthState.currentHp - appliedDamage);

        CombatHandler.applyNpcHealthState(entity, healthState.maxHp, nextHp, authoritativeKill);
        if (appliedDamage > 0) {
            CombatHandler.incrementHostileHpVersion(entity);
        }
        CombatHandler.syncHostileHealthCopies(levelName, entity, nextHp, healthState.maxHp);

        if (usesSharedDungeonProgress(getScopeLevelName(levelName))) {
            noteSharedDungeonHostileState(levelName, targetId, entity);
            LevelHandler.refreshSharedDungeonQuestProgress(levelName);
        }

        return {
            entity,
            entityId: Math.max(0, Math.round(Number(entity.id ?? targetId))),
            appliedDamage,
            killed: authoritativeKill &&
                wasAlive &&
                (Boolean(entity.dead) || Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD)
        };
    }

    private static markEnemyDefeatProcessed(levelScope: string, entityId: number, entity: any): void {
        if (entity && typeof entity === 'object') {
            entity.questDefeatProcessed = true;
        }

        const scopedEntity = levelScope ? GlobalState.levelEntities.get(levelScope)?.get(entityId) : null;
        if (scopedEntity && typeof scopedEntity === 'object') {
            scopedEntity.questDefeatProcessed = true;
        }

        if (!levelScope) {
            return;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (getClientLevelScope(other) !== levelScope) {
                continue;
            }
            const localEntity = other.entities.get(entityId);
            if (localEntity && typeof localEntity === 'object') {
                localEntity.questDefeatProcessed = true;
            }
        }
    }

    private static fireAndForgetMissionWork(client: Client, label: string, work: () => Promise<void>): void {
        const executeWork = (): void => {
            void work().catch((error) => {
                console.error(`[CombatHandler] Error processing ${label}:`, error);
            });
        };

        const hasLiveSocket = Boolean(
            (client as Client & { socket?: { write?: unknown } }).socket?.write
        );

        if (hasLiveSocket) {
            setImmediate(executeWork);
            return;
        }

        executeWork();
    }

    private static observeDungeonCompletion(client: Client, entity: any, label: string): void {
        // Completion state is part of the ordered death packet transaction. Do
        // not move it to setImmediate: the per-client packet queue is a Promise
        // chain, so a movement backlog can otherwise starve this work long
        // after loot and death packets have already been handled.
        void MissionHandler.handleForcedDungeonBossCompletion(client, entity).catch((error) => {
            console.error(`[CombatHandler] Error processing ${label}:`, error);
        });
    }

    private static handleCanonicalVisibleServerAuthorityDefeatSideEffects(
        client: Client,
        levelScope: string,
        entity: any
    ): void {
        const levelName = getScopeLevelName(levelScope);
        const canonicalId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        const canonicalEntity = canonicalId > 0
            ? (GlobalState.levelEntities.get(levelScope)?.get(canonicalId) ?? entity)
            : entity;
        if (
            !levelName ||
            !EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelName) ||
            !EntityHandler.isServerAuthorityHostileEntity(levelName, canonicalEntity)
        ) {
            return;
        }

        const hp = Math.round(Number(canonicalEntity?.hp ?? 0));
        const dead = Boolean(canonicalEntity?.dead) || Number(canonicalEntity?.entState ?? EntityState.ACTIVE) === EntityState.DEAD;
        if (hp <= 0 && dead && !Boolean(canonicalEntity?.destroyed)) {
            CombatHandler.finalizeHostileDeath(client, levelScope, canonicalId, canonicalEntity, {
                includeAnchor: true,
                sendHpCorrection: false,
                reason: 'canonical_visible_reward_finalization'
            });
            return;
        }

        const finalized = Math.round(Number(canonicalEntity?.hp ?? 0)) <= 0 &&
            Boolean(canonicalEntity?.dead) &&
            Boolean(canonicalEntity?.destroyed) &&
            (
                Math.max(0, Math.round(Number(canonicalEntity?.deathFinalizedAt ?? 0))) > 0 ||
                Boolean(canonicalEntity?.finalDeathReason)
            );
        if (!finalized) {
            return;
        }

        if (Boolean(canonicalEntity?.lootDropped)) {
        } else {
            const lifeNonce = Math.max(0, Math.round(Number(
                canonicalEntity?.lifeNonce ?? CombatHandler.getEntityLifeNonce(levelScope, canonicalId)
            ) || 0));
            const lootDropNonce = `${levelScope}:${canonicalId}:${lifeNonce}`;
            canonicalEntity.lootDropped = true;
            canonicalEntity.lootDropNonce = lootDropNonce;
            canonicalEntity.lootGrantedTokens = canonicalEntity.lootGrantedTokens instanceof Set
                ? canonicalEntity.lootGrantedTokens
                : new Set<number>(Array.isArray(canonicalEntity.lootGrantedTokens) ? canonicalEntity.lootGrantedTokens.map((token: unknown) => Math.round(Number(token) || 0)) : []);
            canonicalEntity.lootCollectedTokens = canonicalEntity.lootCollectedTokens instanceof Set
                ? canonicalEntity.lootCollectedTokens
                : new Set<string>(Array.isArray(canonicalEntity.lootCollectedTokens) ? canonicalEntity.lootCollectedTokens.map((token: unknown) => String(token)) : []);
            canonicalEntity.lootDrops = canonicalEntity.lootDrops instanceof Map
                ? canonicalEntity.lootDrops
                : new Map<number, unknown>();
            canonicalEntity.deathRewardGrantedAt = Date.now();
            RewardHandler.grantServerEnemyRewardToEligibleViewers(client, canonicalEntity, {
                levelScope,
                lootDropNonce,
                sourceEnemyCanonicalId: canonicalId,
                caller: 'canonical_hostile_death'
            });
        }

        if (MissionHandler.isRequiredDungeonCompletionBossForLevel(levelName, canonicalEntity)) {
            const roomId = Math.max(0, Math.round(Number(canonicalEntity?.roomId ?? canonicalEntity?.RoomID ?? canonicalEntity?.room_id ?? 0) || 0));
            LevelHandler.sendRoomUnlock(client, roomId);
        }
    }

    private static handleEnemyDefeatState(
        client: Client,
        levelScope: string,
        entityId: number,
        entity: any,
        options: { fromDestroy?: boolean; fromKillState?: boolean } = {}
    ): void {
        if (!entity || entity.isPlayer || Number(entity.team ?? 0) !== EntityTeam.ENEMY) {
            return;
        }

        if (
            !options.fromDestroy &&
            !options.fromKillState &&
            MissionHandler.shouldWaitForEnemyKillStateMissionProgress(client, entity)
        ) {
            return;
        }

        if (Boolean(entity.questDefeatProcessed)) {
            CombatHandler.observeDungeonCompletion(client, entity, 'deduplicated dungeon completion observation');
            return;
        }

        CombatHandler.markEnemyDefeatProcessed(levelScope, entityId, entity);
        TutorialDungeonMechanics.noteEntityDefeated(client, entity);
        CombatHandler.handleCanonicalVisibleServerAuthorityDefeatSideEffects(client, levelScope, entity);
        CombatHandler.fireAndForgetMissionWork(
            client,
            'enemy defeat mission progress',
            () => MissionHandler.handleEnemyDefeatMissionProgressForScope(client, levelScope, entity)
        );

        CombatHandler.observeDungeonCompletion(client, entity, 'forced dungeon boss completion');
    }

    private static parseReferencedEntityIds(packetId: number, data: Buffer): number[] {
        const refs: number[] = [];
        const br = new BitReader(data);

        try {
            switch (packetId) {
                case 0x09: {
                    refs.push(br.readMethod9());
                    break;
                }
                case 0x0A: {
                    refs.push(br.readMethod9());
                    refs.push(br.readMethod9());
                    break;
                }
                case 0x0B:
                case 0x0C:
                    refs.push(br.readMethod9());
                    break;
                case 0x0E:
                    refs.push(br.readMethod9());
                    refs.push(br.readMethod9());
                    break;
                default:
                    break;
            }
        } catch {
            return [];
        }

        return Array.from(new Set(refs.filter((id) => Number.isFinite(id) && id > 0)));
    }

    private static maybeRecordNpcContribution(levelScope: string, targetId: number, sourceId: number, damage: number, fallbackClient: Client): void {
        if (!levelScope || targetId <= 0 || sourceId <= 0 || damage <= 0) {
            return;
        }

        const targetEntity = CombatHandler.resolveLevelEntity(levelScope, targetId);
        if (!targetEntity || targetEntity.isPlayer || Number(targetEntity.team ?? 0) !== 2) {
            return;
        }

        const sourceEntity = CombatHandler.resolveLevelEntity(levelScope, sourceId);
        const summonerId = Number(sourceEntity?.summonerId ?? 0);
        const ownerToken = Number(sourceEntity?.ownerToken ?? 0);

        const sourceSession =
            (fallbackClient.clientEntID === sourceId ? fallbackClient : null) ??
            CombatHandler.findPlayerSessionByEntityId(sourceId) ??
            (fallbackClient.clientEntID === summonerId ? fallbackClient : null) ??
            CombatHandler.findPlayerSessionByEntityId(summonerId) ??
            (ownerToken > 0 ? GlobalState.sessionsByToken.get(ownerToken) ?? null : null);
        if (!sourceSession || !sourceSession.playerSpawned || getClientLevelScope(sourceSession) !== levelScope) {
            return;
        }

        targetEntity.playerDamageContributed = true;
        CombatHandler.recordContribution(levelScope, targetId, sourceSession, damage);
    }

    private static resolveCombatSourceSession(levelScope: string, sourceId: number, fallbackClient: Client): Client | null {
        if (!levelScope || sourceId <= 0) {
            return null;
        }

        const sourceEntity = CombatHandler.resolveLevelEntity(levelScope, sourceId);
        const summonerId = Number(sourceEntity?.summonerId ?? 0);
        const ownerToken = Number(sourceEntity?.ownerToken ?? 0);

        const sourceSession =
            (fallbackClient.clientEntID === sourceId ? fallbackClient : null) ??
            CombatHandler.findPlayerSessionByEntityId(sourceId) ??
            (fallbackClient.clientEntID === summonerId ? fallbackClient : null) ??
            CombatHandler.findPlayerSessionByEntityId(summonerId) ??
            (ownerToken > 0 ? GlobalState.sessionsByToken.get(ownerToken) ?? null : null);
        if (!sourceSession || !sourceSession.playerSpawned || getClientLevelScope(sourceSession) !== levelScope) {
            return null;
        }

        return sourceSession;
    }

    private static shouldSuppressForeignOwnedHit(
        client: Client,
        sourceSession: Client | null,
        isHostileNpcSource: boolean
    ): boolean {
        return Boolean(sourceSession && sourceSession !== client && !isHostileNpcSource);
    }

    private static shouldSuppressServerAuthorityPlayerHostileHitEcho(
        levelName: string,
        sourceSession: Client | null,
        targetSession: Client | null,
        isHostileNpcSource: boolean,
        targetEntity: any,
        rawTargetEntity: any
    ): boolean {
        if (!EntityHandler.usesServerAuthorityHostiles(levelName) || !sourceSession || targetSession || isHostileNpcSource) {
            return false;
        }

        const candidate = targetEntity ?? rawTargetEntity;
        return Boolean(candidate && !candidate.isPlayer && Number(candidate.team ?? 0) === EntityTeam.ENEMY);
    }

    static async handlePowerCast(client: Client, data: Buffer): Promise<void> {
        if (LevelHandler.isGoblinRiverBossIntroLocked(client)) {
            return;
        }
        const info = CombatHandler.parsePowerCastRelayInfo(data);
        if (!info) {
            return;
        }

        const levelScope = getClientLevelScope(client);
        const aliasedSourceId = EntityHandler.resolveEntityAlias(client, info.sourceId);
        const canonicalSourceId = CombatHandler.resolveClientHostileEntityAlias(client, levelScope, aliasedSourceId);
        if (canonicalSourceId !== info.sourceId) {
            info.sourceId = canonicalSourceId;
            data = CombatHandler.buildPowerCastPayload(info);
        }

        if (CombatHandler.shouldSuppressCutsceneHostileCombat(client, levelScope, info.sourceId)) {
            return;
        }

        const sourceSession = CombatHandler.resolveCombatSourceSession(levelScope, info.sourceId, client);
        if (sourceSession && TutorialDungeonMechanics.isTutorialDungeon(levelScope)) {
            const sequences = ((sourceSession as any).serverAuthorityCastSequences ??= new Map<string, number>()) as Map<string, number>;
            const castKey = `${levelScope}:${info.sourceId}:${info.powerId}`;
            sequences.set(castKey, Math.max(0, Math.round(Number(sequences.get(castKey) ?? 0))) + 1);
        }
        const sourceEntity = CombatHandler.resolvePowerCastSourceEntity(levelScope, info.sourceId, client);
        if (CombatHandler.shouldSuppressHostileBossPower(levelScope, sourceEntity)) {
            return;
        }
        if (CombatHandler.shouldSuppressDeadPartySharedHostileAction(client, levelScope, sourceEntity, 'power_cast')) {
            return;
        }
        if (CombatHandler.shouldSuppressNonAuthorityPartySharedHostileAction(client, levelScope, sourceEntity)) {
            return;
        }
        if (sourceSession) {
            noteDungeonRunCast(sourceSession, {
                sourceId: info.sourceId,
                powerId: info.powerId,
                hasTargetEntity: info.hasTargetEntity,
                hasTargetPos: info.hasTargetPos,
                projectileId: info.projectileId,
                isPersistent: info.isPersistent,
                comboData: info.comboData
            });
        }

        const relayPayload = CombatHandler.normalizePowerCastRelay(client, info, data);
        if (!relayPayload) {
            return;
        }

        CombatHandler.broadcastCombatPacket(client, 0x09, relayPayload, {
            referencedEntityIds: CombatHandler.parseReferencedEntityIds(0x09, relayPayload)
        });
        const relayInfo = CombatHandler.parsePowerCastRelayInfo(relayPayload) ?? info;
        CombatHandler.applyFireBrandPiercingCastDamage(client, levelScope, relayInfo, sourceSession, sourceEntity);
    }

    static async handlePowerHit(client: Client, data: Buffer): Promise<void> {
        if (LevelHandler.isGoblinRiverBossIntroLocked(client)) {
            return;
        }
        const parsedInfo = CombatHandler.parsePowerHitRelayInfo(data);
        if (!parsedInfo) {
            return;
        }
        const info = CombatHandler.resolveClientEntityAliases(client, parsedInfo);

        const { targetId, sourceId, damage } = info;
        const currentLevel = client.currentLevel;
        const levelScope = getClientLevelScope(client);
        if (LevelHandler.isDungeonCutsceneCombatLocked(client)) {
            return;
        }
        if (CombatHandler.shouldSuppressCutsceneHostileCombat(client, levelScope, sourceId)) {
            return;
        }
        const powerSourceEntity = CombatHandler.resolvePowerCastSourceEntity(levelScope, sourceId, client);
        if (CombatHandler.shouldSuppressHostileBossPower(levelScope, powerSourceEntity)) {
            return;
        }
        const rawTargetEntity = client.entities.get(parsedInfo.targetId) ?? null;
        const targetEntity = CombatHandler.resolveLevelEntity(levelScope, targetId);
        const sourceEntity = CombatHandler.resolveLevelEntity(levelScope, sourceId);
        const isHostileNpcSource = Boolean(
            sourceEntity &&
            !sourceEntity.isPlayer &&
            Number(sourceEntity.team ?? 0) === EntityTeam.ENEMY
        );
        if (targetEntity && CombatHandler.isTerminalHostileEntity(targetEntity)) {
            return;
        }
        if (isHostileNpcSource && CombatHandler.isTerminalHostileEntity(sourceEntity)) {
            const sourceCanonicalId = Math.max(0, Math.round(Number(sourceEntity?.id ?? sourceId)));
            if (
                sourceCanonicalId > 0 &&
                CombatHandler.shouldMirrorClientSpawnEntityToParty(getScopeLevelName(levelScope), sourceEntity)
            ) {
                CombatHandler.relayPartyLocalEntityDefeat(
                    client,
                    levelScope,
                    sourceCanonicalId,
                    sourceEntity,
                    { requireKnownOrLocal: false, sendHpCorrection: false, includeAnchor: true }
                );
            }
            CombatHandler.sendPostDeathSourceCorrection(client, levelScope, sourceEntity, parsedInfo.sourceId, 'powerhit-source');
            return;
        }
        if (isHostileNpcSource && CombatHandler.shouldSuppressDeadPartySharedHostileAction(client, levelScope, sourceEntity, 'power_hit')) {
            return;
        }
        if (isHostileNpcSource && CombatHandler.shouldSuppressNonAuthorityPartySharedHostileAction(client, levelScope, sourceEntity)) {
            return;
        }
        if (targetEntity && !targetEntity.isPlayer && Boolean(targetEntity.untargetable)) {
            return;
        }

        const sourceSession = CombatHandler.resolveCombatSourceSession(levelScope, sourceId, client);
        if (CombatHandler.shouldSuppressForeignOwnedHit(client, sourceSession, isHostileNpcSource)) {
            return;
        }
        if (CombatHandler.shouldSuppressDuplicateFireBrandThirdShotHit(info, levelScope)) {
            return;
        }
        if (
            info.powerId === CombatHandler.FIREBRAND_PIERCING_SHOT_POWER_ID &&
            CombatHandler.didRecentlyApplyFireBrandPiercingCastDamage(levelScope, sourceId)
        ) {
            return;
        }
        if (targetEntity && TutorialDungeonMechanics.isCompletionBoss(levelScope, targetEntity)) {
            const authorityClient = sourceSession ?? client;
            const sequences = ((authorityClient as any).serverAuthorityCastSequences ?? new Map<string, number>()) as Map<string, number>;
            const castSequence = Math.max(0, Math.round(Number(sequences.get(`${levelScope}:${sourceId}:${info.powerId}`) ?? 0)));
            const eventId = `${sourceId}:${targetId}:${info.powerId}:${castSequence}:${damage}:${info.isCrit ? 1 : 0}`;
            const processed = (targetEntity.processedDamageEventIds ??= new Set<string>()) as Set<string>;
            if (castSequence > 0) {
                if (processed.has(eventId)) {
                    return;
                }
                processed.add(eventId);
            } else {
                const fallbackKey = `${levelScope}:${authorityClient.token}:${data.toString('hex')}`;
                const now = Date.now();
                const lastAt = Math.max(0, Number(CombatHandler.recentTutorialBossHitPackets.get(fallbackKey) ?? 0));
                CombatHandler.recentTutorialBossHitPackets.set(fallbackKey, now);
                if (lastAt > 0 && now - lastAt <= 100) {
                    return;
                }
            }
        }

        if (client.currentLevel === 'CraftTownTutorial' && client.keepTutorialState) {
            LevelHandler.checkCraftTownTutorialBossHealth(client, targetId, damage);
        }

        if (damage > 0) {
            CombatHandler.noteCombatInteraction(levelScope, sourceId, targetId, client);
        }

        CombatHandler.maybeRecordNpcContribution(levelScope, targetId, sourceId, damage, client);
        if (
            sourceSession &&
            targetEntity &&
            !targetEntity.isPlayer &&
            Number(targetEntity.team ?? 0) === EntityTeam.ENEMY &&
            damage > 0
        ) {
            noteDungeonRunHit(sourceSession, {
                sourceId,
                targetId,
                targetEntity,
                damage
            });
        }

        let relayDamage = damage;
        let serverAuthorityNpcResolution: NpcHitResolution | null = null;
        let partySharedHostileHealthRelay: {
            entity: any;
            snapshots: Map<number, HostileViewerHealthSnapshot>;
            appliedDamage: number;
        } | null = null;
        let partySharedHostileDeathRelay: { entityId: number; entity: any; anchor: Client } | null = null;
        let serverAuthorityNpcSnapshots = new Map<number, HostileViewerHealthSnapshot>();
        const targetSession = CombatHandler.findPlayerSessionByEntityId(targetId);
        if (targetSession && areClientsInSameLevelScope(client, targetSession)) {
            const resolution = CombatHandler.updatePlayerTargetAfterHit(targetSession, damage);
            relayDamage = resolution.appliedDamage;

            if (resolution.appliedDamage > 0 && !isHostileNpcSource) {
                CombatHandler.broadcastPlayerHpDelta(targetSession, -resolution.appliedDamage);
            }

            if (resolution.killed) {
                CombatHandler.armBossRegenForPlayerDeath(targetSession);
                CombatHandler.broadcastPlayerState(targetSession, EntityState.DEAD, isHostileNpcSource);
                EquipmentHandler.broadcastGearChange(targetSession, true);
            }
        } else {
            const deferDungeonCompletionUntilDestroy = Boolean(
                targetEntity &&
                !targetEntity.isPlayer &&
                Number(targetEntity.team ?? 0) === EntityTeam.ENEMY &&
                MissionHandler.shouldProcessEnemyKillStateDungeonCompletion(client, targetEntity)
            );
            const partySharedHostileSnapshots = targetEntity &&
                CombatHandler.shouldMirrorClientSpawnEntityToParty(currentLevel, targetEntity)
                ? CombatHandler.snapshotPartySharedHostileViewerHealth(sourceSession ?? client, levelScope, targetEntity)
                : new Map<number, HostileViewerHealthSnapshot>();
            serverAuthorityNpcSnapshots = targetEntity &&
                CombatHandler.isServerAuthoritySyncNpc(levelScope, targetEntity)
                ? CombatHandler.snapshotServerAuthorityNpcViewerHealth(sourceSession ?? client, levelScope, targetEntity)
                : new Map<number, HostileViewerHealthSnapshot>();
            CombatHandler.assignPartySharedHostileCombatAuthority(levelScope, targetEntity, sourceSession ?? client);
            const hpBefore = Math.max(0, Math.round(Number(targetEntity?.hp ?? 0)));
            const resolution = CombatHandler.updateNpcTargetAfterHit(levelScope, targetId, damage);
            if (resolution.entity && Math.max(0, Math.round(Number(resolution.appliedDamage ?? 0))) > 0) {
                TutorialDungeonMechanics.noteBossHealth(sourceSession ?? client, resolution.entity);
                if (CombatHandler.isServerAuthoritySyncNpc(levelScope, resolution.entity)) {
                    CombatHandler.broadcastAuthoritativeServerAuthorityHp(
                        sourceSession ?? client,
                        levelScope,
                        resolution.entity,
                        'powerhit'
                    );
                }
            }
            if (resolution.entity) {
                relayDamage = Math.max(0, Math.round(Number(resolution.appliedDamage ?? relayDamage)));
                if (CombatHandler.shouldMirrorClientSpawnEntityToParty(currentLevel, resolution.entity)) {
                }
            }
            if (resolution.entity && CombatHandler.isServerAuthoritySyncNpc(levelScope, resolution.entity)) {
                serverAuthorityNpcResolution = resolution;
                relayDamage = Math.max(0, Math.round(Number(resolution.appliedDamage ?? relayDamage)));
            }
            if (
                resolution.entity &&
                !serverAuthorityNpcResolution &&
                CombatHandler.shouldMirrorClientSpawnEntityToParty(currentLevel, resolution.entity)
            ) {
                partySharedHostileHealthRelay = {
                    entity: resolution.entity,
                    snapshots: partySharedHostileSnapshots,
                    appliedDamage: Math.max(0, Math.round(Number(resolution.appliedDamage ?? 0)))
                };
                CombatHandler.rememberPartySharedHostileHpApply(
                    levelScope,
                    Math.max(0, Math.round(Number(resolution.entityId ?? resolution.entity.id ?? targetId)))
                );
            }
            if (resolution.killed && resolution.entity && !deferDungeonCompletionUntilDestroy) {
                CombatHandler.handleEnemyDefeatState(sourceSession ?? client, levelScope, targetId, resolution.entity);
            }
            if (
                resolution.killed &&
                resolution.entity &&
                CombatHandler.shouldMirrorClientSpawnEntityToParty(currentLevel, resolution.entity)
            ) {
                partySharedHostileDeathRelay = {
                    entityId: Math.max(0, Math.round(Number(resolution.entityId ?? targetId))),
                    entity: resolution.entity,
                    anchor: sourceSession ?? client
                };
            }
        }

        const displayRelayDamage = CombatHandler.clampRelayPowerHitDamage(relayDamage);
        const relayPayload = displayRelayDamage === damage && info === parsedInfo
            ? data
            : CombatHandler.buildPowerHitPayload(info, displayRelayDamage);
        if (partySharedHostileHealthRelay?.entity) {
            CombatHandler.convergePartySharedHostileHealthToParty(
                sourceSession ?? client,
                levelScope,
                partySharedHostileHealthRelay.entity,
                partySharedHostileHealthRelay.snapshots,
                -displayRelayDamage,
                -displayRelayDamage
            );
        }
        if (serverAuthorityNpcResolution?.entity) {
            CombatHandler.rememberServerAuthorityProxyHpApply(
                levelScope,
                Math.max(0, Math.round(Number(serverAuthorityNpcResolution.entity.id ?? targetId)))
            );
            const relayed = CombatHandler.relayServerAuthorityNpcHit(
                client,
                levelScope,
                serverAuthorityNpcResolution.entity,
                relayPayload,
                [targetId, sourceId],
                Math.max(0, Math.round(Number(serverAuthorityNpcResolution.appliedDamage ?? displayRelayDamage))),
                sourceId,
                serverAuthorityNpcSnapshots
            );
            if (serverAuthorityNpcResolution.killed) {
                CombatHandler.relayServerAuthorityNpcDeath(client, levelScope, serverAuthorityNpcResolution.entity);
            }
            if (relayed) {
                return;
            }
        }
        if (
            CombatHandler.shouldSuppressServerAuthorityPlayerHostileHitEcho(
                currentLevel,
                sourceSession,
                targetSession,
                isHostileNpcSource,
                targetEntity,
                rawTargetEntity
            )
        ) {
            return;
        }
        if (isHostileNpcSource) {
            const excludeLocalVictim = targetSession === client ? client : null;
            CombatHandler.broadcastEntityViewPacket(levelScope, sourceEntity, 0x0A, relayPayload, [targetId, sourceId], excludeLocalVictim);
            return;
        }

        CombatHandler.broadcastCombatPacket(client, 0x0A, relayPayload, {
            referencedEntityIds: [targetId, sourceId]
        });
        if (partySharedHostileDeathRelay) {
            CombatHandler.relayPartyLocalEntityDefeat(
                partySharedHostileDeathRelay.anchor,
                levelScope,
                partySharedHostileDeathRelay.entityId,
                partySharedHostileDeathRelay.entity,
                { requireKnownOrLocal: true, sendHpCorrection: false, includeAnchor: true }
            );
        }
    }

    static async handleProjectileExplode(client: Client, data: Buffer): Promise<void> {
        if (LevelHandler.isGoblinRiverBossIntroLocked(client)) {
            return;
        }
        if (LevelHandler.isDungeonCutsceneCombatLocked(client)) {
            return;
        }
        CombatHandler.broadcastCombatPacket(client, 0x0E, data, {
            referencedEntityIds: CombatHandler.parseReferencedEntityIds(0x0E, data)
        });
    }

    static async handleEntityDestroy(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const rawEntityId = br.readMethod9();
        let entityId = EntityHandler.resolveEntityAlias(client, rawEntityId);
        let destroyPayload = rawEntityId === entityId
            ? data
            : (() => {
                const bb = new BitBuffer(false);
                bb.writeMethod4(entityId);
                bb.writeMethod15(true);
                return bb.toBuffer();
            })();
        const levelName = client.currentLevel;
        const levelScope = getClientLevelScope(client);
        if (levelScope) {
            const sharedEntityId = CombatHandler.resolveClientHostileEntityAlias(client, levelScope, entityId);
            if (sharedEntityId !== entityId) {
                entityId = sharedEntityId;
                destroyPayload = CombatHandler.buildDestroyEntityPayload(entityId, true);
            }
        }
        const canonicalDestroyedEntity = levelScope ? GlobalState.levelEntities.get(levelScope)?.get(entityId) : null;
        const canonicalServerAuthorityEntity = CombatHandler.isServerAuthoritySyncNpc(levelScope, canonicalDestroyedEntity)
            ? canonicalDestroyedEntity
            : null;
        const rawLocalDestroyedEntity = client.entities.get(rawEntityId) ?? null;
        const destroyedEntity = EntityHandler.usesServerAuthorityHostiles(levelName)
            ? (canonicalServerAuthorityEntity ?? client.entities.get(entityId) ?? rawLocalDestroyedEntity ?? canonicalDestroyedEntity)
            : (client.entities.get(entityId) ?? canonicalDestroyedEntity ?? rawLocalDestroyedEntity);
        const scriptedAuthority = TutorialDungeonMechanics.isTutorialDungeon(levelName)
            ? TutorialDungeonMechanics.getAuthorityEntity(rawLocalDestroyedEntity, Number(client.currentRoomId ?? 0))
            : null;
        if (scriptedAuthority && scriptedAuthority.role !== 'boss' && scriptedAuthority.role !== 'anna') {
            const transition = TutorialDungeonMechanics.commitClientObjectDefeat(client, rawLocalDestroyedEntity);
            if (transition.accepted && transition.authority) {
                rawLocalDestroyedEntity.dead = true;
                rawLocalDestroyedEntity.destroyed = true;
                rawLocalDestroyedEntity.hp = 0;
                rawLocalDestroyedEntity.entState = EntityState.DEAD;
                EntityHandler.broadcastTutorialDungeonObjectTransition(client, transition.authority);
                if (transition.authority.role === 'anna_chain') {
                    await MissionHandler.handleForcedDungeonObjectiveCompletion(client, rawLocalDestroyedEntity);
                }
            } else if (transition.dedupe) {
                EntityHandler.applyTutorialDungeonWorldSnapshotToLocalObject(client, rawLocalDestroyedEntity, rawEntityId);
            }
            return;
        }
        let isSeedOutsideClientSpawnDestroy = false;
        if (
            destroyedEntity &&
            !Boolean(destroyedEntity.isPlayer) &&
            Number(destroyedEntity.team ?? 0) === EntityTeam.ENEMY &&
            CombatHandler.shouldMirrorClientSpawnEntityToParty(levelName, destroyedEntity)
        ) {
        }
        if (EntityHandler.usesServerAuthorityHostiles(levelName)) {
            const isCanonicalServerAuthorityDestroy = Boolean(
                canonicalServerAuthorityEntity ||
                CombatHandler.isServerAuthoritySyncNpc(levelScope, destroyedEntity)
            );
            isSeedOutsideClientSpawnDestroy = Boolean(
                !isCanonicalServerAuthorityDestroy &&
                rawLocalDestroyedEntity &&
                CombatHandler.shouldMirrorClientSpawnEntityToParty(levelName, rawLocalDestroyedEntity)
            );
            if (isSeedOutsideClientSpawnDestroy) {
                entityId = rawEntityId;
                destroyPayload = data;
            } else
            if (!destroyedEntity || !CombatHandler.isServerAuthoritySyncNpc(levelScope, destroyedEntity)) {
                EntityHandler.destroyClientLocalEntity(client, rawEntityId, 'client_destroy_unresolved_server_authority', destroyedEntity);
                return;
            }

            if (!isSeedOutsideClientSpawnDestroy) {
                if (Boolean(destroyedEntity.destroyed)) {
                    CombatHandler.sendHostileDeathCorrectionToViewer(
                        client,
                        levelScope,
                        destroyedEntity,
                        rawEntityId,
                        'client_destroy_post_death'
                    );
                    return;
                }
                EntityHandler.normalizeServerAuthorityHostileState(levelScope, destroyedEntity);
            }

            if (
                !isSeedOutsideClientSpawnDestroy &&
                Math.round(Number(destroyedEntity.hp ?? 0)) > 0
            ) {
                destroyedEntity.dead = false;
                if (Number(destroyedEntity.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
                    destroyedEntity.entState = EntityState.ACTIVE;
                }
                CombatHandler.sendServerAuthorityAliveCorrection(client, levelScope, destroyedEntity, 'client_destroy_rejected_alive', rawEntityId);
                return;
            }
        }
        if (EntityHandler.isHomeDummyEntity(destroyedEntity)) {
            destroyedEntity.entState = EntityState.ACTIVE;
            destroyedEntity.dead = false;
            destroyedEntity.healthDelta = 0;
            destroyedEntity.health_delta = 0;
            destroyedEntity.hp = Math.max(
                1,
                Math.round(Number(destroyedEntity.maxHp ?? 0)) || CombatHandler.estimateHostileMaxHp(destroyedEntity)
            );
            if (levelScope) {
                const scopedEntity = GlobalState.levelEntities.get(levelScope)?.get(entityId);
                if (scopedEntity && scopedEntity !== destroyedEntity) {
                    scopedEntity.entState = EntityState.ACTIVE;
                    scopedEntity.dead = false;
                    scopedEntity.healthDelta = 0;
                    scopedEntity.health_delta = 0;
                    scopedEntity.hp = destroyedEntity.hp;
                }
            }
            EntityHandler.sendEntity(client, destroyedEntity);
            return;
        }
        const contributionSnapshot = destroyedEntity && !destroyedEntity.isPlayer && Number(destroyedEntity.team ?? 0) === EntityTeam.ENEMY
            ? CombatHandler.getContributionSnapshot(levelScope, entityId)
            : null;
        const shouldMirrorClientSpawnEntity = Boolean(
            levelName &&
            CombatHandler.shouldMirrorClientSpawnEntityToParty(levelName, destroyedEntity)
        );
        const shouldRelayDestroy = EntityHandler.shouldRelayEntityToOtherClients(levelName, destroyedEntity);
        if (destroyedEntity && contributionSnapshot?.contributors?.length) {
            destroyedEntity.clientDefeatVerified = true;
        }

        const shouldProcessDefeatState = Boolean(
            destroyedEntity &&
            !destroyedEntity.isPlayer &&
            Number(destroyedEntity.team ?? 0) === EntityTeam.ENEMY &&
            !MissionHandler.shouldIgnoreUnverifiedDungeonBossDefeat(levelName, destroyedEntity)
        );

        if (shouldMirrorClientSpawnEntity && destroyedEntity && !isSeedOutsideClientSpawnDestroy) {
            const healthState = CombatHandler.resolveHostileHealthStateAcrossCopies(levelScope, destroyedEntity) ??
                CombatHandler.getNpcHealthState(destroyedEntity);
            const canonicalHp = Math.max(0, Math.round(Number(destroyedEntity.hp ?? healthState?.currentHp ?? 0)));
            if (Boolean(destroyedEntity.destroyed)) {
                return;
            }
            if (canonicalHp > 0) {
                destroyedEntity.dead = false;
                if (Number(destroyedEntity.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
                    destroyedEntity.entState = EntityState.ACTIVE;
                }
                const localEntity = client.entities.get(rawEntityId) ?? client.entities.get(entityId) ?? {};
                const localHp = Math.max(0, Math.round(Number(localEntity?.hp ?? healthState?.maxHp ?? canonicalHp)));
                const correctionDelta = canonicalHp - localHp;
                if (correctionDelta !== 0) {
                    client.send(
                        CombatHandler.CLIENT_HEAL_PACKET_ID,
                        CombatHandler.buildHpDeltaPayload(rawEntityId, correctionDelta)
                    );
                }
                client.send(
                    0x07,
                    CombatHandler.buildEntityStatePayload(
                        rawEntityId,
                        Number(destroyedEntity.entState ?? EntityState.ACTIVE),
                        Boolean(destroyedEntity.facingLeft)
                    )
                );
                return;
            }

            CombatHandler.finalizeHostileDeath(client, levelScope, entityId, destroyedEntity, {
                includeAnchor: true,
                sendHpCorrection: false,
                reason: 'client_destroy_dead_canonical'
            });
            if (usesSharedDungeonProgress(getScopeLevelName(levelScope))) {
                noteSharedDungeonHostileDestroyed(levelScope, entityId, destroyedEntity);
                LevelHandler.refreshSharedDungeonQuestProgress(levelScope);
            }
            if (shouldProcessDefeatState) {
                CombatHandler.handleEnemyDefeatState(client, levelScope, entityId, destroyedEntity, { fromDestroy: true });
            }
            CombatHandler.relayPartyLocalEntityDefeat(
                client,
                levelScope,
                entityId,
                destroyedEntity,
                { includeAnchor: true, sendHpCorrection: false }
            );
            return;
        }

        if (levelName === 'CraftTownTutorial' && client.keepTutorialState) {
            const entityName = String(destroyedEntity?.name ?? '');
            if (entityName === 'GoblinShamanHood' || entityName === 'IntroGoblinShamanHood') {
                client.keepTutorialState.bossDefeated = true;
                client.keepTutorialState.helperWaveActiveIds = [];
                clearKeepTutorialTimers(client.keepTutorialState);
            } else if (entityName === 'GoblinDagger') {
                LevelHandler.noteCraftTownTutorialHelperDestroyed(client, entityId);
            }
        }

        client.entities.delete(rawEntityId);
        client.entities.delete(entityId);

        if (levelScope) {
            if (usesSharedDungeonProgress(getScopeLevelName(levelScope)) && destroyedEntity) {
                noteSharedDungeonHostileDestroyed(levelScope, entityId, destroyedEntity);
            }
            if (CombatHandler.isServerAuthoritySyncNpc(levelScope, destroyedEntity)) {
                EntityHandler.noteServerAuthorityHostileDestroyed(levelScope, entityId, destroyedEntity);
            }
            const levelMap = GlobalState.levelEntities.get(levelScope);
            levelMap?.delete(entityId);
            if (levelMap && levelMap.size === 0) {
                GlobalState.levelEntities.delete(levelScope);
            }
            if (contributionSnapshot?.contributors?.length) {
                noteDungeonRunKill(levelScope, contributionSnapshot.contributors, entityId, destroyedEntity);
            }
            CombatHandler.noteEntityDestroyed(levelScope, entityId);
            EntityHandler.forgetKnownEntity(levelName, entityId, client.levelInstanceId);
            if (usesSharedDungeonProgress(getScopeLevelName(levelScope)) && destroyedEntity) {
                LevelHandler.refreshSharedDungeonQuestProgress(levelScope);
                if (EntityHandler.usesServerAuthorityHostiles(getScopeLevelName(levelScope))) {
                    CombatHandler.refreshServerAuthorityProgressWithRetries(levelScope, 'entity_destroy');
                }
            }
        }

        if (
            shouldProcessDefeatState &&
            destroyedEntity &&
            !destroyedEntity.isPlayer &&
            Number(destroyedEntity.team ?? 0) === EntityTeam.ENEMY
        ) {
            CombatHandler.handleEnemyDefeatState(client, levelScope, entityId, destroyedEntity, { fromDestroy: true });
        }

        if (shouldRelayDestroy) {
            if (CombatHandler.isServerAuthoritySyncNpc(levelScope, destroyedEntity)) {
                CombatHandler.broadcastServerAuthorityNpcDestroy(client, levelScope, entityId, destroyedEntity, true);
            } else {
                CombatHandler.broadcastToSameLevel(levelScope, 0x0D, destroyPayload, [], client);
            }
        } else if (shouldMirrorClientSpawnEntity) {
            CombatHandler.relayPartyLocalEntityDefeat(
                client,
                levelScope,
                entityId,
                destroyedEntity,
                {
                    includeAnchor: !EntityHandler.usesServerAuthorityHostiles(levelName),
                    sendHpCorrection: false
                }
            );
        }
    }

    static handleRequestRespawn(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        let usePotion = br.readMethod15();
        const nowMs = Date.now();
        const hadPendingRespawn = Boolean(client.pendingRespawnRequest);
        if (usePotion) {
            usePotion = CombatHandler.tryConsumeRespawnPotion(client);
        }

        if (!usePotion && !hadPendingRespawn) {
            noteDungeonRunDeath(client);
            client.processedRewardSources.clear();
            CombatHandler.clearLevelEnemyRewardTrackingForRespawn(client);
            CombatHandler.notePlayerDeathState(client);
        }

        if (!CombatHandler.hasFreshRespawnCombatStats(client, nowMs)) {
            CombatHandler.deferRespawnResponseForCombatStats(client, usePotion, nowMs);
            return;
        }

        CombatHandler.sendRespawnResponse(client, usePotion);
    }

    static handleRespawnBroadcast(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const rawEntId = br.readMethod9();
        const entId = EntityHandler.resolveEntityAlias(client, rawEntId);
        const clientHealAmount = Math.max(0, Math.round(br.readMethod24()));
        const usedPotion = br.readMethod15();
        if (usedPotion) {
            CombatHandler.tryConsumeRespawnPotion(client);
        }

        const isSelfRespawn = entId === client.clientEntID;
        const levelScope = getClientLevelScope(client);
        const respawnEntity = client.currentLevel ? CombatHandler.resolveLevelEntity(levelScope, entId) : null;
        if (!isSelfRespawn && CombatHandler.isServerAuthoritySyncNpc(levelScope, respawnEntity)) {
            CombatHandler.correctServerAuthorityHostileProxy(
                client,
                levelScope,
                respawnEntity,
                'hostile_respawn_rejected',
                rawEntId
            );
            return;
        }
        const healAmount = isSelfRespawn
            ? Math.max(clientHealAmount, CombatHandler.getRespawnHealAmount(client))
            : clientHealAmount;

        const ent = client.entities.get(entId);
        if (ent) {
            ent.dead = false;
            ent.entState = EntityState.ACTIVE;
            ent.hp = healAmount;
            ent.maxHp = Math.max(Math.round(Number(ent.maxHp ?? 0)), healAmount);
            ent.lastCombatActivityAt = 0;
            ent.lastCombatRegenTickAt = 0;
        }

        if (client.currentLevel) {
            const levelEntity = CombatHandler.resolveLevelEntity(levelScope, entId);
            if (levelEntity && typeof levelEntity === 'object') {
                levelEntity.dead = false;
                levelEntity.entState = EntityState.ACTIVE;
                levelEntity.hp = healAmount;
                levelEntity.maxHp = Math.max(Math.round(Number(levelEntity.maxHp ?? 0)), healAmount);
                levelEntity.lastCombatActivityAt = 0;
                levelEntity.lastCombatRegenTickAt = 0;
            }
        }

        if (usesSharedDungeonProgress(getScopeLevelName(levelScope))) {
            const levelEntity = CombatHandler.resolveLevelEntity(levelScope, entId);
            if (levelEntity && !levelEntity.isPlayer) {
                noteSharedDungeonHostileState(levelScope, entId, levelEntity);
                LevelHandler.refreshSharedDungeonQuestProgress(levelScope);
            }
        }

        if (entId === client.clientEntID) {
            client.authoritativeCurrentHp = healAmount;
            client.authoritativeMaxHp = Math.max(client.authoritativeMaxHp, healAmount);
            client.lastCombatActivityAt = 0;
            client.lastCombatRegenTickAt = 0;
            CombatHandler.clearEnemyDeathRegenArm(client);
            const facingLeft = Boolean(ent?.facingLeft ?? false);
            const statePayload = CombatHandler.buildEntityStatePayload(client.clientEntID, EntityState.ACTIVE, facingLeft);
            CombatHandler.broadcastToSameLevel(getClientLevelScope(client), 0x07, statePayload, [client.clientEntID], client);
            EquipmentHandler.broadcastGearChange(client, true);
        }

        const bb = new BitBuffer(false);
        bb.writeMethod4(entId);
        bb.writeMethod24(healAmount);
        CombatHandler.broadcastToSameLevel(getClientLevelScope(client), 0x82, bb.toBuffer(), [entId], client);
    }

    private static recordClientHostileHpDelta(
        client: Client,
        levelScope: string,
        rawEntityId: number,
        entityId: number,
        entity: any,
        amount: number
    ): boolean {
        if (!levelScope || entityId <= 0 || amount === 0) {
            return false;
        }

        const levelEntity = CombatHandler.resolveLevelEntity(levelScope, entityId);
        const targetEntity = levelEntity ?? entity;
        if (EntityHandler.usesServerAuthorityHostiles(getScopeLevelName(levelScope))) {
            if (CombatHandler.isServerAuthoritySyncNpc(levelScope, targetEntity)) {
                const canonicalId = Math.max(0, Math.round(Number(targetEntity.id ?? entityId)));
                if (CombatHandler.isTerminalHostileEntity(targetEntity)) {
                    CombatHandler.relayServerAuthorityNpcDeath(
                        client,
                        levelScope,
                        targetEntity
                    );
                    return true;
                }
                if (Math.round(Number(targetEntity.hp ?? 0)) > 0) {
                    targetEntity.dead = false;
                    if (Number(targetEntity.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
                        targetEntity.entState = EntityState.ACTIVE;
                    }
                }
                EntityHandler.normalizeServerAuthorityHostileState(levelScope, targetEntity);
                const currentHp = Math.max(0, Math.round(Number(targetEntity.hp ?? 0)));
                if (!CombatHandler.isCanonicalHostileTerminal(levelScope, targetEntity)) {
                    const viewers = CombatHandler.broadcastAuthoritativeServerAuthorityHp(
                        client,
                        levelScope,
                        targetEntity,
                        'client_hostile_hp_report'
                    );
                    if (Math.round(Number(targetEntity.hp ?? 0)) <= CombatHandler.DEATH_EPSILON_HP || amount < 0) {
                    }
                    CombatHandler.sendServerAuthorityAliveCorrection(client, levelScope, targetEntity, 'client_hostile_hp_report', rawEntityId);
                } else {
                    CombatHandler.relayServerAuthorityNpcDeath(client, levelScope, targetEntity);
                    return true;
                }
                CombatHandler.convergeServerAuthorityNpcHealthToParty(
                    client,
                    levelScope,
                    targetEntity,
                    'client_hostile_hp_report',
                    rawEntityId
                );
                return true;
            }
            return true;
        }

        if (
            targetEntity &&
            !Boolean(targetEntity?.isPlayer) &&
            Number(targetEntity?.team ?? 0) === EntityTeam.ENEMY &&
            CombatHandler.shouldMirrorClientSpawnEntityToParty(getScopeLevelName(levelScope), targetEntity)
        ) {
            const canonicalId = Math.max(0, Math.round(Number(targetEntity.id ?? entityId)));
            if (CombatHandler.isTerminalHostileEntity(targetEntity)) {
                CombatHandler.relayPartyLocalEntityDefeat(
                    client,
                    levelScope,
                    canonicalId,
                    targetEntity,
                    { requireKnownOrLocal: false, sendHpCorrection: false, includeAnchor: true }
                );
                return true;
            }

            const healthState = CombatHandler.resolveHostileHealthStateAcrossCopies(levelScope, targetEntity) ??
                CombatHandler.getNpcHealthState(targetEntity);
            if (!healthState || healthState.maxHp <= 0) {
                return true;
            }

            const snapshots = CombatHandler.snapshotPartySharedHostileViewerHealth(client, levelScope, targetEntity);
            if (healthState.currentHp > 0) {
                targetEntity.dead = false;
                if (Number(targetEntity.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
                    targetEntity.entState = EntityState.ACTIVE;
                }
            }
            CombatHandler.convergePartySharedHostileHealthToParty(
                client,
                levelScope,
                targetEntity,
                snapshots,
                0,
                0
            );

            return true;
        }

        if (
            !targetEntity ||
            Boolean(targetEntity?.isPlayer) ||
            Number(targetEntity?.team ?? 0) !== EntityTeam.ENEMY ||
            (
                !CombatHandler.isDungeonBossEntity(levelScope, targetEntity) &&
                !MissionHandler.shouldProcessEnemyKillStateDungeonCompletion(client, targetEntity)
            )
        ) {
            return false;
        }

        const healthState = CombatHandler.resolveHostileHealthStateAcrossCopies(levelScope, targetEntity);
        if (!healthState || healthState.maxHp <= 0) {
            return true;
        }

        if (CombatHandler.isTerminalHostileEntity(targetEntity)) {
            return true;
        }

        if (healthState.currentHp > 0) {
            targetEntity.dead = false;
            if (Number(targetEntity.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
                targetEntity.entState = EntityState.ACTIVE;
            }
        }

        if (amount < 0) {
            const nowMs = Date.now();
            for (const copy of CombatHandler.collectHostileHealthCopies(levelScope, targetEntity)) {
                CombatHandler.setEntityCombatActivity(copy, nowMs);
                CombatHandler.setEntityLastRegenTickAt(copy, 0);
            }
        }
        return true;
    }

    static handleCharRegen(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const rawEntityId = br.readMethod9();
        const amount = Math.round(br.readMethod24());
        const levelScope = getClientLevelScope(client);
        const entityId = CombatHandler.resolveClientHostileEntityAlias(
            client,
            levelScope,
            EntityHandler.resolveEntityAlias(client, rawEntityId)
        );
        const entity = client.entities.get(entityId) ?? CombatHandler.resolveLevelEntity(levelScope, entityId);
        if (!EntityHandler.isClientOwnPlayerEntity(client, levelScope, entityId, entity)) {
            if (amount < 0 && entity && !entity.isPlayer && Boolean(entity.untargetable)) {
                return;
            }
            if (amount < 0 && LevelHandler.isDungeonCutsceneCombatLocked(client)) {
                return;
            }
            if (CombatHandler.recordClientHostileHpDelta(client, levelScope, rawEntityId, entityId, entity, amount)) {
                return;
            }
            return;
        }

        const levelEntity = CombatHandler.resolveLevelEntity(levelScope, entityId);
        const maxHp = CombatHandler.resolvePlayerMaxHp(client, entity, levelEntity);
        const currentHp = CombatHandler.resolvePlayerCurrentHp(client, entity, levelEntity, maxHp);
        const nextHp = Math.max(0, Math.min(maxHp, currentHp + amount));
        const appliedDelta = nextHp - currentHp;
        if (nextHp <= 0) {
            CombatHandler.notePlayerDeathState(client);
            if (appliedDelta !== 0) {
                CombatHandler.broadcastPlayerHpDelta(client, appliedDelta, false);
            }
            CombatHandler.broadcastPlayerState(client, EntityState.DEAD);
            return;
        }

        if (entity && typeof entity === 'object') {
            entity.maxHp = maxHp;
            entity.hp = nextHp;
            entity.dead = false;
            if (Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
                entity.entState = EntityState.ACTIVE;
            }
        }

        if (levelEntity && typeof levelEntity === 'object') {
            levelEntity.maxHp = maxHp;
            levelEntity.hp = nextHp;
            levelEntity.dead = false;
            if (Number(levelEntity.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
                levelEntity.entState = EntityState.ACTIVE;
            }
        }

        client.authoritativeMaxHp = maxHp;
        client.authoritativeCurrentHp = nextHp;
        if (appliedDelta !== 0) {
            CombatHandler.broadcastPlayerHpDelta(client, appliedDelta, false);
        }
        if (amount < 0) {
            CombatHandler.notePlayerDamageTakenActivity(client, Date.now());
        }
    }

    private static getServerAuthorityActiveBuffs(entity: any): Record<string, ServerAuthorityBuffSnapshot> {
        if (!entity || typeof entity !== 'object') {
            return {};
        }

        const existing = entity.activeBuffs && typeof entity.activeBuffs === 'object' && !Array.isArray(entity.activeBuffs)
            ? entity.activeBuffs as Record<string, ServerAuthorityBuffSnapshot>
            : {};
        entity.activeBuffs = existing;
        return existing;
    }

    private static getServerAuthorityBuffPacketKey(data: Buffer): string {
        const trailingHex = CombatHandler.trailingBitsAfterLeadingMethod9Hex(data);
        return trailingHex || data.toString('hex');
    }

    private static parseServerAuthorityBuffPayload(data: Buffer): {
        targetId: number;
        buffId: number;
        durationMs: number;
        uncertain: boolean;
    } {
        const parsed = {
            targetId: 0,
            buffId: 0,
            durationMs: 0,
            uncertain: true
        };

        try {
            const br = new BitReader(data);
            parsed.targetId = br.readMethod4();
            parsed.buffId = br.remainingBits() > 0 ? br.readMethod4() : 0;
            if (br.remainingBits() <= 0) {
                return parsed;
            }

            const rawDuration = Math.max(0, Math.round(br.readMethod24()));
            if (rawDuration <= 0) {
                return parsed;
            }

            parsed.durationMs = rawDuration >= 1000 ? rawDuration : rawDuration * 1000;
            parsed.uncertain = true;
            return parsed;
        } catch {
            return parsed;
        }
    }

    private static mirrorServerAuthorityBuffStateToViewerCache(
        viewer: Client,
        canonicalId: number,
        entity: any
    ): void {
        const localId = EntityHandler.resolveEntityLocalId(viewer, canonicalId);
        const localEntity = viewer.entities.get(localId) ?? viewer.entities.get(canonicalId);
        if (!localEntity || typeof localEntity !== 'object') {
            return;
        }

        localEntity.activeBuffs = { ...(entity?.activeBuffs ?? {}) };
        localEntity.buffStateVersion = Math.max(0, Math.round(Number(entity?.buffStateVersion ?? 0)));
        localEntity.lastBuffStateAt = Math.max(0, Math.round(Number(entity?.lastBuffStateAt ?? 0)));
        viewer.entities.set(localId > 0 ? localId : canonicalId, localEntity);
    }

    private static recordServerAuthorityBuffPacket(
        client: Client,
        packetId: number,
        data: Buffer
    ): { payload: Buffer; referencedEntityIds: number[] } {
        const rawTargetId = CombatHandler.parseBuffTargetEntityId(data);
        const parsedBuff = CombatHandler.parseServerAuthorityBuffPayload(data);
        const levelScope = getClientLevelScope(client);
        const canonicalTargetId = CombatHandler.resolveClientHostileEntityAlias(
            client,
            levelScope,
            EntityHandler.resolveEntityAlias(client, rawTargetId)
        );
        if (packetId !== 0x0B) {
        }
        const payload = rawTargetId > 0 && canonicalTargetId > 0 && rawTargetId !== canonicalTargetId
            ? CombatHandler.replaceLeadingMethod9(data, canonicalTargetId)
            : data;
        const entity = CombatHandler.resolveLevelEntity(levelScope, canonicalTargetId);
        if (
            !CombatHandler.isServerAuthoritySyncNpc(levelScope, entity) &&
            !CombatHandler.shouldMirrorClientSpawnEntityToParty(getScopeLevelName(levelScope), entity)
        ) {
            return {
                payload,
                referencedEntityIds: CombatHandler.parseReferencedEntityIds(packetId, payload)
            };
        }

        const key = CombatHandler.getServerAuthorityBuffPacketKey(payload);
        const activeBuffs = CombatHandler.getServerAuthorityActiveBuffs(entity);
        const nowMs = Date.now();
        if (packetId === 0x0B) {
            if (parsedBuff.durationMs <= 0) {
            }
            activeBuffs[key] = {
                key,
                packetId,
                targetId: canonicalTargetId,
                buffId: parsedBuff.buffId,
                durationMs: parsedBuff.durationMs,
                expiresAt: parsedBuff.durationMs > 0 ? nowMs + parsedBuff.durationMs : 0,
                sourceToken: Math.max(0, Math.round(Number(client.token ?? 0))),
                sourceName: String(client.character?.name ?? ''),
                payloadHex: payload.toString('hex'),
                updatedAt: nowMs
            };
        } else {
            delete activeBuffs[key];
        }

        entity.buffStateVersion = Math.max(0, Math.round(Number(entity.buffStateVersion ?? 0))) + 1;
        entity.lastBuffStateAt = nowMs;
        for (const viewer of GlobalState.sessionsByToken.values()) {
            if (getClientLevelScope(viewer) !== levelScope) {
                continue;
            }
            CombatHandler.mirrorServerAuthorityBuffStateToViewerCache(viewer, canonicalTargetId, entity);
        }

        return {
            payload,
            referencedEntityIds: [canonicalTargetId]
        };
    }

    static processBuffExpirations(levelScope: string, nowMs: number = Date.now()): void {
        if (!levelScope) {
            return;
        }

        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (!levelMap) {
            return;
        }

        for (const entity of levelMap.values()) {
            if (!entity || entity.isPlayer || Number(entity.team ?? 0) !== EntityTeam.ENEMY) {
                continue;
            }

            const activeBuffs = CombatHandler.getServerAuthorityActiveBuffs(entity);
            const expired = Object.values(activeBuffs).filter((snapshot) =>
                Math.max(0, Math.round(Number(snapshot.expiresAt ?? 0))) > 0 &&
                Math.max(0, Math.round(Number(snapshot.expiresAt ?? 0))) <= nowMs
            );
            if (expired.length === 0) {
                continue;
            }

            for (const snapshot of expired) {
                CombatHandler.broadcastCanonicalBuffRemoval(levelScope, entity, snapshot, 'buff_expired');
                delete activeBuffs[snapshot.key];
            }

            entity.buffStateVersion = Math.max(0, Math.round(Number(entity.buffStateVersion ?? 0))) + 1;
            entity.lastBuffStateAt = nowMs;
            const canonicalId = Math.max(0, Math.round(Number(entity.id ?? 0)));
            for (const viewer of GlobalState.sessionsByToken.values()) {
                if (getClientLevelScope(viewer) === levelScope) {
                    CombatHandler.mirrorServerAuthorityBuffStateToViewerCache(viewer, canonicalId, entity);
                }
            }
        }
    }

    static async handleBuffTickDot(client: Client, data: Buffer): Promise<void> {
        const info = CombatHandler.parseBuffTickDotInfo(data);
        if (!info) {
            CombatHandler.broadcastCombatPacket(client, 0x79, data);
            return;
        }

        const rawTargetId = info.targetId;
        const rawSourceId = info.sourceId;
        const levelScope = getClientLevelScope(client);
        info.targetId = CombatHandler.resolveClientHostileEntityAlias(
            client,
            levelScope,
            EntityHandler.resolveEntityAlias(client, rawTargetId)
        );
        info.sourceId = CombatHandler.resolveClientHostileEntityAlias(
            client,
            levelScope,
            EntityHandler.resolveEntityAlias(client, rawSourceId)
        );
        if (LevelHandler.isDungeonCutsceneCombatLocked(client)) {
            return;
        }

        const { targetId, sourceId, damage } = info;
        const targetEntity = CombatHandler.resolveLevelEntity(levelScope, targetId);
        const sourceEntity = CombatHandler.resolveLevelEntity(levelScope, sourceId);
        const isHostileNpcSource = Boolean(
            sourceEntity &&
            !sourceEntity.isPlayer &&
            Number(sourceEntity.team ?? 0) === EntityTeam.ENEMY
        );
        if (targetEntity && CombatHandler.isTerminalHostileEntity(targetEntity)) {
            return;
        }
        if (isHostileNpcSource && CombatHandler.isTerminalHostileEntity(sourceEntity)) {
            const sourceCanonicalId = Math.max(0, Math.round(Number(sourceEntity?.id ?? sourceId)));
            if (
                sourceCanonicalId > 0 &&
                CombatHandler.shouldMirrorClientSpawnEntityToParty(getScopeLevelName(levelScope), sourceEntity)
            ) {
                CombatHandler.relayPartyLocalEntityDefeat(
                    client,
                    levelScope,
                    sourceCanonicalId,
                    sourceEntity,
                    { requireKnownOrLocal: false, sendHpCorrection: false, includeAnchor: true }
                );
            }
            CombatHandler.sendPostDeathSourceCorrection(client, levelScope, sourceEntity, rawSourceId, 'buff-tick-dot-source');
            return;
        }
        if (isHostileNpcSource && CombatHandler.shouldSuppressDeadPartySharedHostileAction(client, levelScope, sourceEntity, 'buff_tick_dot')) {
            return;
        }
        if (isHostileNpcSource && CombatHandler.shouldSuppressNonAuthorityPartySharedHostileAction(client, levelScope, sourceEntity)) {
            return;
        }
        if (targetEntity && !targetEntity.isPlayer && Boolean(targetEntity.untargetable)) {
            return;
        }

        const sourceSession = CombatHandler.resolveCombatSourceSession(levelScope, sourceId, client);
        if (CombatHandler.shouldSuppressForeignOwnedHit(client, sourceSession, isHostileNpcSource)) {
            return;
        }

        if (damage > 0) {
            CombatHandler.noteCombatInteraction(levelScope, sourceId, targetId, client);
        }

        CombatHandler.maybeRecordNpcContribution(levelScope, targetId, sourceId, damage, client);
        if (
            sourceSession &&
            targetEntity &&
            !targetEntity.isPlayer &&
            Number(targetEntity.team ?? 0) === EntityTeam.ENEMY &&
            damage > 0
        ) {
            noteDungeonRunHit(sourceSession, {
                sourceId,
                targetId,
                targetEntity,
                damage
            });
        }

        const deferDungeonCompletionUntilDestroy = Boolean(
            targetEntity &&
            !targetEntity.isPlayer &&
            Number(targetEntity.team ?? 0) === EntityTeam.ENEMY &&
            MissionHandler.shouldProcessEnemyKillStateDungeonCompletion(client, targetEntity)
        );
        const partySharedHostileSnapshots = targetEntity &&
            CombatHandler.shouldMirrorClientSpawnEntityToParty(client.currentLevel, targetEntity)
            ? CombatHandler.snapshotPartySharedHostileViewerHealth(sourceSession ?? client, levelScope, targetEntity)
            : new Map<number, HostileViewerHealthSnapshot>();
        CombatHandler.assignPartySharedHostileCombatAuthority(levelScope, targetEntity, sourceSession ?? client);
        const hpBefore = Math.max(0, Math.round(Number(targetEntity?.hp ?? 0)));
        const resolution = CombatHandler.updateNpcTargetAfterHit(levelScope, targetId, damage);
        if (resolution.entity && Math.max(0, Math.round(Number(resolution.appliedDamage ?? 0))) > 0) {
            TutorialDungeonMechanics.noteBossHealth(sourceSession ?? client, resolution.entity);
            if (CombatHandler.isServerAuthoritySyncNpc(levelScope, resolution.entity)) {
                CombatHandler.broadcastAuthoritativeServerAuthorityHp(
                    sourceSession ?? client,
                    levelScope,
                    resolution.entity,
                    'buff-tick-dot'
                );
            }
        }
        if (resolution.entity && CombatHandler.isServerAuthoritySyncNpc(levelScope, resolution.entity)) {
            CombatHandler.rememberServerAuthorityProxyHpApply(
                levelScope,
                Math.max(0, Math.round(Number(resolution.entity.id ?? targetId)))
            );
            CombatHandler.convergeServerAuthorityNpcHealthToParty(
                client,
                levelScope,
                resolution.entity,
                'buff_tick_dot',
                rawTargetId
            );
            if (resolution.killed) {
                if (!deferDungeonCompletionUntilDestroy) {
                    CombatHandler.handleEnemyDefeatState(sourceSession ?? client, levelScope, targetId, resolution.entity);
                }
                CombatHandler.relayServerAuthorityNpcDeath(client, levelScope, resolution.entity);
            }
            return;
        }
        if (
            resolution.entity &&
            CombatHandler.shouldMirrorClientSpawnEntityToParty(client.currentLevel, resolution.entity)
        ) {
            const appliedDamage = Math.max(0, Math.round(Number(resolution.appliedDamage ?? 0)));
            CombatHandler.rememberPartySharedHostileHpApply(
                levelScope,
                Math.max(0, Math.round(Number(resolution.entityId ?? resolution.entity.id ?? targetId)))
            );
            CombatHandler.convergePartySharedHostileHealthToParty(
                sourceSession ?? client,
                levelScope,
                resolution.entity,
                partySharedHostileSnapshots,
                -appliedDamage,
                -appliedDamage
            );
        }
        if (resolution.killed && resolution.entity && !deferDungeonCompletionUntilDestroy) {
            CombatHandler.handleEnemyDefeatState(sourceSession ?? client, levelScope, targetId, resolution.entity);
        }
        const partySharedHostileDeathRelay = (
            resolution.killed &&
            resolution.entity &&
            CombatHandler.shouldMirrorClientSpawnEntityToParty(client.currentLevel, resolution.entity)
        )
            ? {
                entityId: Math.max(0, Math.round(Number(resolution.entityId ?? targetId))),
                entity: resolution.entity,
                anchor: sourceSession ?? client
            }
            : null;

        const relayPayload = info.targetId === rawTargetId && info.sourceId === rawSourceId
            ? data
            : CombatHandler.buildBuffTickDotPayload(info);

        CombatHandler.broadcastCombatPacket(client, 0x79, relayPayload, {
            referencedEntityIds: [targetId, sourceId]
        });
        if (partySharedHostileDeathRelay) {
            CombatHandler.relayPartyLocalEntityDefeat(
                partySharedHostileDeathRelay.anchor,
                levelScope,
                partySharedHostileDeathRelay.entityId,
                partySharedHostileDeathRelay.entity,
                { requireKnownOrLocal: true, sendHpCorrection: false, includeAnchor: true }
            );
        }
    }

    static async handleAddBuff(client: Client, data: Buffer): Promise<void> {
        const rawTargetId = CombatHandler.parseBuffTargetEntityId(data);
        const levelScope = getClientLevelScope(client);
        const targetId = CombatHandler.resolveClientHostileEntityAlias(
            client,
            levelScope,
            EntityHandler.resolveEntityAlias(client, rawTargetId)
        );
        const targetEntity = CombatHandler.resolveLevelEntity(levelScope, targetId);
        if (targetEntity && CombatHandler.isTerminalHostileEntity(targetEntity)) {
            return;
        }
        const recorded = CombatHandler.recordServerAuthorityBuffPacket(client, 0x0B, data);
        CombatHandler.broadcastCombatPacket(client, 0x0B, recorded.payload, {
            referencedEntityIds: recorded.referencedEntityIds
        });
    }

    static async handleRemoveBuff(client: Client, data: Buffer): Promise<void> {
        const recorded = CombatHandler.recordServerAuthorityBuffPacket(client, 0x0C, data);
        CombatHandler.broadcastCombatPacket(client, 0x0C, recorded.payload, {
            referencedEntityIds: recorded.referencedEntityIds
        });
    }
}
