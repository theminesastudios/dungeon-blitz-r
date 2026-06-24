import { Client, clearKeepTutorialTimers } from '../core/Client';
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

export class CombatHandler {
    private static readonly MAX_RELAY_POWER_HIT_DAMAGE = 4_000_000;
    private static readonly FIREBRAND_THIRD_SHOT_POWER_ID = 6144;
    private static readonly FIREBRAND_PIERCING_SHOT_POWER_ID = 6146;
    private static readonly FIREBRAND_PIERCING_SHOT_RANGE = 800;
    private static readonly FIREBRAND_PIERCING_SHOT_MIN_HIT_RADIUS = 35;
    private static readonly FIREBRAND_PIERCING_HIT_DEDUPE_MS = 1_500;
    private static readonly FIREBRAND_THIRD_SHOT_HIT_DEDUPE_MS = 300;
    private static readonly recentFireBrandThirdShotHits = new Map<string, number>();
    private static readonly recentFireBrandPiercingCasts = new Map<string, number>();

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
    private static readonly POWER_HIT_CLIENT_AUTHORITY_BOSS_LEVELS = new Set([
        'AC_Mission5',
        'AC_Mission5Hard',
        'JC_Mission1',
        'JC_Mission1Hard',
        'SRN_Mission1',
        'SRN_Mission1Hard'
    ]);
    private static readonly POWER_HIT_CLIENT_AUTHORITY_BOSS_NAMES = new Set([
        'AncientDragonBlack',
        'AncientDragonBlackHard',
        'AncientDragonSilver',
        'AncientDragonSilverHard',
        'ImperialChampion',
        'ImperialChampionHard',
        'LizardLord',
        'LizardLordHard'
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

    private static logPlayerHp(
        label: string,
        client: Client,
        details: Record<string, unknown>,
        throttleMs: number = 0,
        nowMs: number = Date.now()
    ): void {
        const reason = String(details.reason ?? '');
        const key = `${client.token}:${client.clientEntID}:${label}:${reason}`;
        if (throttleMs > 0) {
            const previousAt = Math.max(0, Number(CombatHandler.recentPlayerHpLogs.get(key) ?? 0));
            if (nowMs - previousAt < throttleMs) {
                return;
            }
            CombatHandler.recentPlayerHpLogs.set(key, nowMs);
        }

        const characterName = String(client.character?.name ?? 'unknown').replace(/\s+/g, '_');
        const levelScope = getClientLevelScope(client) || 'none';
        const formattedDetails = Object.entries(details)
            .map(([detailKey, value]) => `${detailKey}=${String(value)}`)
            .join(' ');
        console.log(
            `[CombatRegen][${label}] player=${characterName} token=${client.token} ent=${client.clientEntID} level=${levelScope} ${formattedDetails}`
        );
    }

    private static logBossRegen(
        label: string,
        levelScope: string,
        entity: any,
        details: Record<string, unknown> = {},
        throttleMs: number = CombatHandler.BOSS_REGEN_LOG_THROTTLE_MS,
        nowMs: number = Date.now()
    ): void {
        const entityId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        const reason = String(details.reason ?? '');
        const key = `${levelScope}:${entityId}:${label}:${reason}`;
        if (throttleMs > 0) {
            const previousAt = Math.max(0, Number(CombatHandler.recentBossRegenLogs.get(key) ?? 0));
            if (nowMs - previousAt < throttleMs) {
                return;
            }
            CombatHandler.recentBossRegenLogs.set(key, nowMs);
        }

        const entityName = String(entity?.name ?? entity?.EntName ?? entity?.entName ?? 'unknown').replace(/\s+/g, '_');
        const displayName = String(
            entity?.roomBossName ??
            entity?.displayName ??
            entity?.DisplayName ??
            entity?.characterName ??
            entity?.character_name ??
            ''
        ).replace(/\s+/g, '_');
        const formattedDetails = Object.entries(details)
            .map(([detailKey, value]) => `${detailKey}=${String(value)}`)
            .join(' ');
        console.log(
            `[CombatRegen][${label}] level=${levelScope || 'none'} boss=${entityName} display=${displayName || 'none'} ent=${entityId} ${formattedDetails}`
        );
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
        return Boolean(entity?.dead) || Number(entity?.entState ?? EntityState.ACTIVE) === EntityState.DEAD;
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
            CombatHandler.logBossRegen('boss-hp-report-alias', levelScope, roomBoss, {
                rawEntityId: localId,
                entityId: roomBossId,
                reason: 'single-room-boss'
            }, 0);
            return roomBossId;
        }

        return localId;
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

    private static shouldDeferPowerHitKillToClient(levelScope: string, entity: any): boolean {
        const levelName = getScopeLevelName(levelScope);
        if (
            !levelName ||
            !CombatHandler.POWER_HIT_CLIENT_AUTHORITY_BOSS_LEVELS.has(levelName) ||
            !Boolean(entity?.clientSpawned)
        ) {
            return false;
        }

        const entityName = String(entity?.name ?? entity?.EntName ?? entity?.entName ?? '').trim();
        return CombatHandler.POWER_HIT_CLIENT_AUTHORITY_BOSS_NAMES.has(entityName) ||
            CombatHandler.isKnownClientRoomBossEntity(levelName, entity);
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
            CombatHandler.logPlayerHp('regen-skip', client, {
                reason: 'combat-stats-dirty',
                authHp: Math.round(Number(client.authoritativeCurrentHp ?? 0)),
                authMax: Math.round(Number(client.authoritativeMaxHp ?? 0)),
                lastCombatAt: Math.max(0, client.lastCombatActivityAt),
                lastTickAt: Math.max(0, client.lastCombatRegenTickAt)
            }, CombatHandler.PLAYER_HP_LOG_THROTTLE_MS, nowMs);
            return;
        }

        const entity = client.entities.get(client.clientEntID) ??
            CombatHandler.resolveLevelEntity(levelScope, client.clientEntID);
        const levelEntity = CombatHandler.resolveLevelEntity(levelScope, client.clientEntID);
        if (CombatHandler.isEntityDead(entity) || CombatHandler.isEntityDead(levelEntity)) {
            CombatHandler.logPlayerHp('regen-skip', client, {
                reason: 'dead',
                entityHp: Math.round(Number(entity?.hp ?? 0)),
                levelHp: Math.round(Number(levelEntity?.hp ?? 0)),
                authHp: Math.round(Number(client.authoritativeCurrentHp ?? 0)),
                authMax: Math.round(Number(client.authoritativeMaxHp ?? 0))
            }, CombatHandler.PLAYER_HP_LOG_THROTTLE_MS, nowMs);
            return;
        }

        const maxHp = CombatHandler.resolvePlayerMaxHp(client, entity, levelEntity);
        const currentHp = CombatHandler.resolvePlayerCurrentHp(client, entity, levelEntity, maxHp);
        if (currentHp <= 0 || currentHp >= maxHp) {
            if (currentHp < maxHp) {
                CombatHandler.logPlayerHp('regen-skip', client, {
                    reason: 'invalid-hp',
                    currentHp,
                    maxHp,
                    entityHp: Math.round(Number(entity?.hp ?? 0)),
                    levelHp: Math.round(Number(levelEntity?.hp ?? 0)),
                    authHp: Math.round(Number(client.authoritativeCurrentHp ?? 0)),
                    authMax: Math.round(Number(client.authoritativeMaxHp ?? 0))
                }, CombatHandler.PLAYER_HP_LOG_THROTTLE_MS, nowMs);
            }
            return;
        }

        if (Math.max(0, client.lastCombatActivityAt) <= 0) {
            client.lastCombatActivityAt = Math.max(0, nowMs - CombatHandler.PLAYER_OUT_OF_COMBAT_REGEN_DELAY_MS);
            client.lastCombatRegenTickAt = 0;
            CombatHandler.logPlayerHp('regen-seed', client, {
                currentHp,
                maxHp,
                entityHp: Math.round(Number(entity?.hp ?? 0)),
                levelHp: Math.round(Number(levelEntity?.hp ?? 0)),
                authHp: Math.round(Number(client.authoritativeCurrentHp ?? 0)),
                authMax: Math.round(Number(client.authoritativeMaxHp ?? 0)),
                lastCombatAt: client.lastCombatActivityAt
            }, CombatHandler.PLAYER_HP_LOG_THROTTLE_MS, nowMs);
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
            CombatHandler.logPlayerHp('regen-wait', client, {
                currentHp,
                maxHp,
                lastCombatAt: Math.max(0, client.lastCombatActivityAt),
                lastTickAt: Math.max(0, client.lastCombatRegenTickAt),
                dueAt: Math.max(0, client.lastCombatRegenTickAt) > 0
                    ? Math.max(0, client.lastCombatRegenTickAt) + CombatHandler.PLAYER_OUT_OF_COMBAT_REGEN_INTERVAL_MS
                    : Math.max(0, client.lastCombatActivityAt) + CombatHandler.PLAYER_OUT_OF_COMBAT_REGEN_DELAY_MS,
                nowMs
            }, CombatHandler.PLAYER_HP_LOG_THROTTLE_MS, nowMs);
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
        CombatHandler.logPlayerHp('regen-heal', client, {
            previousHp: currentHp,
            healAmount,
            nextHp,
            maxHp,
            ticks: regenState.ticks,
            lastCombatAt: Math.max(0, client.lastCombatActivityAt),
            lastTickAt: Math.max(0, client.lastCombatRegenTickAt)
        }, 0, nowMs);
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
            CombatHandler.logBossRegen('boss-regen-skip', levelScope, entity, {
                reason: !healthState
                    ? 'no-health'
                    : healthState.currentHp >= healthState.maxHp
                        ? 'full'
                        : verifiedDefeat
                            ? 'verified-dead'
                            : 'dead',
                currentHp: healthState?.currentHp ?? 0,
                maxHp: healthState?.maxHp ?? 0,
                entityHp: Math.round(Number(entity?.hp ?? 0)),
                healthDelta: CombatHandler.getNpcHealthDelta(entity),
                roomId: Math.round(Number(entity?.roomId ?? -1))
            }, CombatHandler.BOSS_REGEN_LOG_THROTTLE_MS, nowMs);
            return;
        }

        if (deathRegenArmed && !deadDeathRegenPlayer) {
            CombatHandler.clearHostileDeathRegenArm(levelScope, entity, deathRegenArmKey);
            CombatHandler.logBossRegen('boss-regen-skip', levelScope, entity, {
                reason: 'death-player-alive',
                currentHp: healthState.currentHp,
                maxHp: healthState.maxHp,
                healthDelta: CombatHandler.getNpcHealthDelta(entity),
                roomId: Math.round(Number(entity?.roomId ?? -1))
            }, 0, nowMs);
            return;
        }

        if (CombatHandler.hasLivingHostileAggroTarget(levelScope, entity)) {
            CombatHandler.logBossRegen('boss-regen-skip', levelScope, entity, {
                reason: 'living-aggro-target',
                currentHp: healthState.currentHp,
                maxHp: healthState.maxHp,
                aggroTargetEntityId: Math.round(Number(entity?.aggroTargetEntityId ?? 0)),
                aggroTargetToken: Math.round(Number(entity?.aggroTargetToken ?? 0))
            }, CombatHandler.BOSS_REGEN_LOG_THROTTLE_MS, nowMs);
            return;
        }

        if (CombatHandler.hasLivePlayerInBossAggro(levelScope, entity)) {
            CombatHandler.noteHostileCombatActivity(entity, nowMs);
            CombatHandler.logBossRegen('boss-regen-skip', levelScope, entity, {
                reason: 'live-player-aggro',
                currentHp: healthState.currentHp,
                maxHp: healthState.maxHp,
                aggroTargetEntityId: Math.round(Number(entity?.aggroTargetEntityId ?? 0)),
                aggroTargetToken: Math.round(Number(entity?.aggroTargetToken ?? 0))
            }, CombatHandler.BOSS_REGEN_LOG_THROTTLE_MS, nowMs);
            return;
        }

        if (!deathRegenArmed) {
            CombatHandler.logBossRegen('boss-regen-skip', levelScope, entity, {
                reason: 'death-not-armed',
                currentHp: healthState.currentHp,
                maxHp: healthState.maxHp,
                healthDelta: CombatHandler.getNpcHealthDelta(entity),
                roomId: Math.round(Number(entity?.roomId ?? -1))
            }, CombatHandler.BOSS_REGEN_LOG_THROTTLE_MS, nowMs);
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
            CombatHandler.logBossRegen('boss-regen-wait', levelScope, entity, {
                currentHp: healthState.currentHp,
                maxHp: healthState.maxHp,
                lastCombatAt: CombatHandler.getEntityCombatActivityAt(entity),
                lastTickAt: CombatHandler.getEntityLastRegenTickAt(entity),
                dueAt: CombatHandler.getEntityLastRegenTickAt(entity) > 0
                    ? CombatHandler.getEntityLastRegenTickAt(entity) + CombatHandler.DUNGEON_BOSS_REGEN_INTERVAL_MS
                    : CombatHandler.getEntityCombatActivityAt(entity) + CombatHandler.DUNGEON_BOSS_OUT_OF_COMBAT_REGEN_DELAY_MS,
                nowMs
            }, CombatHandler.BOSS_REGEN_LOG_THROTTLE_MS, nowMs);
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
        CombatHandler.logBossRegen('boss-regen-heal', levelScope, entity, {
            previousHp: healthState.currentHp,
            healAmount: actualHeal,
            nextHp,
            maxHp: healthState.maxHp,
            ticks: regenState.ticks,
            viewers
        }, 0, nowMs);
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

            viewer.send(
                CombatHandler.CLIENT_HEAL_PACKET_ID,
                CombatHandler.translateOutboundPacketForViewer(viewer, CombatHandler.CLIENT_HEAL_PACKET_ID, payload)
            );
            viewers++;
        }

        return viewers;
    }

    private static syncHostileHealthCopies(levelScope: string, sourceEntity: any, currentHp: number, maxHp: number): void {
        const entityId = Math.max(0, Math.round(Number(sourceEntity?.id ?? 0)));
        if (!levelScope || entityId <= 0) {
            return;
        }

        const healthDelta = currentHp - maxHp;
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
            entity.maxHp = maxHp;
            entity.hp = currentHp;
            entity.healthDelta = healthDelta;
            entity.health_delta = healthDelta;
            if (currentHp > 0 && Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
                entity.entState = EntityState.ACTIVE;
                entity.dead = false;
            }
        };

        apply(GlobalState.levelEntities.get(levelScope)?.get(entityId));
        if (CombatHandler.isDungeonBossEntity(levelScope, sourceEntity)) {
            for (const copy of CombatHandler.collectHostileHealthCopies(levelScope, sourceEntity, true)) {
                apply(copy);
            }
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

    private static translateEntityIdForViewer(viewer: Client, entityId: number): number {
        return EntityHandler.resolveEntityLocalId(viewer, entityId);
    }

    private static translateOutboundPacketForViewer(viewer: Client, packetId: number, data: Buffer): Buffer {
        try {
            switch (packetId) {
                case 0x09: {
                    const info = CombatHandler.parsePowerCastRelayInfo(data);
                    if (!info) {
                        return data;
                    }

                    const sourceId = CombatHandler.translateEntityIdForViewer(viewer, info.sourceId);
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

                    const targetId = CombatHandler.translateEntityIdForViewer(viewer, info.targetId);
                    const sourceId = CombatHandler.translateEntityIdForViewer(viewer, info.sourceId);
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

                    const targetId = CombatHandler.translateEntityIdForViewer(viewer, info.targetId);
                    const sourceId = CombatHandler.translateEntityIdForViewer(viewer, info.sourceId);
                    if (targetId === info.targetId && sourceId === info.sourceId) {
                        return data;
                    }

                    return CombatHandler.buildBuffTickDotPayload({
                        ...info,
                        targetId,
                        sourceId
                    });
                }
                case 0x07: {
                    const br = new BitReader(data);
                    const entityId = br.readMethod4();
                    const localEntityId = CombatHandler.translateEntityIdForViewer(viewer, entityId);
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
                    const localEntityId = CombatHandler.translateEntityIdForViewer(viewer, entityId);
                    if (localEntityId === entityId) {
                        return data;
                    }

                    const immediate = br.readMethod15();
                    return CombatHandler.buildDestroyEntityPayload(localEntityId, immediate);
                }
                case 0x78: {
                    const br = new BitReader(data);
                    const entityId = br.readMethod4();
                    const localEntityId = CombatHandler.translateEntityIdForViewer(viewer, entityId);
                    if (localEntityId === entityId) {
                        return data;
                    }

                    return CombatHandler.buildHpDeltaPayload(localEntityId, br.readMethod45());
                }
                case 0x82: {
                    const br = new BitReader(data);
                    const entityId = br.readMethod9();
                    const localEntityId = CombatHandler.translateEntityIdForViewer(viewer, entityId);
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
            CombatHandler.logBossRegen('boss-regen-arm', levelScope, entity, {
                player: String(client.character?.name ?? 'unknown').replace(/\s+/g, '_'),
                playerToken: client.token,
                playerEnt: client.clientEntID,
                alreadyArmed: alreadyArmedForThisDeath,
                currentHp: Math.round(Number(entity?.hp ?? 0)),
                maxHp: Math.round(Number(entity?.maxHp ?? 0)),
                healthDelta: CombatHandler.getNpcHealthDelta(entity),
                roomId: Math.round(Number(entity?.roomId ?? -1))
            }, 0, nowMs);
        }

        if (armedBossCount <= 0) {
            console.log(
                `[CombatRegen][boss-regen-arm-none] player=${String(client.character?.name ?? 'unknown').replace(/\s+/g, '_')} token=${client.token} ent=${client.clientEntID} level=${levelScope}`
            );
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
            return EntityHandler.canClientResolveCanonicalEntity(viewer, entityId);
        }

        if (EntityHandler.ensureEntityKnown(viewer, anchor.currentLevel, entityId)) {
            return true;
        }

        if (!areClientsInSameParty(anchor, viewer)) {
            return false;
        }

        return false;
    }

    private static relayPartyLocalEntityDefeat(anchor: Client, levelScope: string, entityId: number): void {
        if (!levelScope || entityId <= 0 || !anchor.playerSpawned) {
            return;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            const localEntityId = EntityHandler.resolveEntityLocalId(other, entityId);
            let updateEntityId = localEntityId;
            let localEntity = other.entities.get(localEntityId) ?? other.entities.get(entityId);
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
            if (
                other === anchor ||
                !other.playerSpawned ||
                getClientLevelScope(other) !== levelScope ||
                !areClientsInSameParty(anchor, other) ||
                !localEntity ||
                !CombatHandler.shouldMirrorClientSpawnEntityToParty(anchor.currentLevel, localEntity)
            ) {
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
            other.send(0x07, CombatHandler.buildEntityStatePayload(updateEntityId, EntityState.DEAD, Boolean(localEntity.facingLeft)));
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

            other.send(packetId, CombatHandler.translateOutboundPacketForViewer(other, packetId, data));
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
        const dedupedRefs = Array.from(new Set(referencedEntityIds.filter((id) => Number.isFinite(id) && id > 0)));

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== levelScope || other === excludedClient) {
                continue;
            }
            if (sourceRoomId >= 0 && !sharesRoomIds(other.currentRoomId, sourceRoomId)) {
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

            other.send(packetId, CombatHandler.translateOutboundPacketForViewer(other, packetId, data));
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

            other.send(packetId, CombatHandler.translateOutboundPacketForViewer(other, packetId, data));
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

        if (EntityHandler.shouldTrackKnownEntity(viewer.currentLevel, entity)) {
            return EntityHandler.ensureEntityKnown(viewer, viewer.currentLevel, entityId);
        }

        if (CombatHandler.shouldMirrorClientSpawnEntityToParty(viewer.currentLevel, entity)) {
            return EntityHandler.canClientResolveCanonicalEntity(viewer, entityId);
        }

        const isRoomScopedClientNpc = Boolean(
            !entity.isPlayer &&
            entity.clientSpawned &&
            sharesRoomIds(viewer.currentRoomId, Number(entity.roomId ?? -1))
        );
        return isRoomScopedClientNpc;
    }

    private static broadcastPlayerHpDelta(targetSession: Client, delta: number): void {
        if (!targetSession.playerSpawned || !targetSession.currentLevel || targetSession.clientEntID <= 0 || delta <= 0) {
            return;
        }

        const payload = CombatHandler.buildHpDeltaPayload(targetSession.clientEntID, delta);
        CombatHandler.broadcastToCombatRoom(targetSession, CombatHandler.CLIENT_HEAL_PACKET_ID, payload, true, [targetSession.clientEntID]);
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

                other.send(0x07, CombatHandler.translateOutboundPacketForViewer(other, 0x07, payload));
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
            const resolution = CombatHandler.updateNpcTargetAfterHit(levelScope, targetId, damage);
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
        const authoritativeKill =
            healthState.authoritativeKill &&
            !CombatHandler.shouldDeferPowerHitKillToClient(levelName, entity);
        const requestedDamage = Math.max(0, Math.round(damage));
        const minHpAfterHit = authoritativeKill ? 0 : 1;
        const appliedDamage = Math.max(0, Math.min(requestedDamage, healthState.currentHp - minHpAfterHit));
        const nextHp = Math.max(minHpAfterHit, healthState.currentHp - appliedDamage);

        CombatHandler.applyNpcHealthState(entity, healthState.maxHp, nextHp, authoritativeKill);
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
            return;
        }

        CombatHandler.markEnemyDefeatProcessed(levelScope, entityId, entity);
        CombatHandler.fireAndForgetMissionWork(
            client,
            'enemy defeat mission progress',
            () => MissionHandler.handleEnemyDefeatMissionProgress(client, entity)
        );

        const destroyedOwnerToken = Math.round(Number((entity as any)?.ownerToken ?? 0));
        const authorityToken = destroyedOwnerToken > 0
            ? destroyedOwnerToken
            : (levelScope ? resolveSharedDungeonProgressAuthorityToken(levelScope) : 0);
        const authorityClient = authorityToken > 0 ? GlobalState.sessionsByToken.get(authorityToken) : null;
        const completionClient = authorityClient && areClientsInSameLevelScope(client, authorityClient)
            ? authorityClient
            : client;
        CombatHandler.fireAndForgetMissionWork(
            client,
            'forced dungeon boss completion',
            () => MissionHandler.handleForcedDungeonBossCompletion(completionClient, entity)
        );
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

    static async handlePowerCast(client: Client, data: Buffer): Promise<void> {
        if (LevelHandler.isGoblinRiverBossIntroLocked(client)) {
            return;
        }
        const info = CombatHandler.parsePowerCastRelayInfo(data);
        if (!info) {
            return;
        }

        const aliasedSourceId = EntityHandler.resolveEntityAlias(client, info.sourceId);
        if (aliasedSourceId !== info.sourceId) {
            info.sourceId = aliasedSourceId;
            data = CombatHandler.buildPowerCastPayload(info);
        }

        const levelScope = getClientLevelScope(client);
        if (CombatHandler.shouldSuppressCutsceneHostileCombat(client, levelScope, info.sourceId)) {
            return;
        }

        const sourceSession = CombatHandler.resolveCombatSourceSession(levelScope, info.sourceId, client);
        const sourceEntity = CombatHandler.resolvePowerCastSourceEntity(levelScope, info.sourceId, client);
        if (CombatHandler.shouldSuppressHostileBossPower(levelScope, sourceEntity)) {
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
        if (CombatHandler.shouldSuppressCutsceneHostileCombat(client, levelScope, sourceId)) {
            return;
        }
        const powerSourceEntity = CombatHandler.resolvePowerCastSourceEntity(levelScope, sourceId, client);
        if (CombatHandler.shouldSuppressHostileBossPower(levelScope, powerSourceEntity)) {
            return;
        }
        const targetEntity = CombatHandler.resolveLevelEntity(levelScope, targetId);
        const sourceEntity = CombatHandler.resolveLevelEntity(levelScope, sourceId);
        const isHostileNpcSource = Boolean(
            sourceEntity &&
            !sourceEntity.isPlayer &&
            Number(sourceEntity.team ?? 0) === EntityTeam.ENEMY
        );
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
            const resolution = CombatHandler.updateNpcTargetAfterHit(levelScope, targetId, damage);
            if (resolution.killed && resolution.entity && !deferDungeonCompletionUntilDestroy) {
                CombatHandler.handleEnemyDefeatState(sourceSession ?? client, levelScope, targetId, resolution.entity);
            }
        }

        const displayRelayDamage = CombatHandler.clampRelayPowerHitDamage(relayDamage);
        const relayPayload = displayRelayDamage === damage && info === parsedInfo
            ? data
            : CombatHandler.buildPowerHitPayload(info, displayRelayDamage);
        if (isHostileNpcSource) {
            const excludeLocalVictim = targetSession === client ? client : null;
            CombatHandler.broadcastEntityViewPacket(levelScope, sourceEntity, 0x0A, relayPayload, [targetId, sourceId], excludeLocalVictim);
            return;
        }

        CombatHandler.broadcastCombatPacket(client, 0x0A, relayPayload, {
            referencedEntityIds: [targetId, sourceId]
        });
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
        const entityId = EntityHandler.resolveEntityAlias(client, rawEntityId);
        const destroyPayload = rawEntityId === entityId
            ? data
            : (() => {
                const bb = new BitBuffer(false);
                bb.writeMethod4(entityId);
                bb.writeMethod15(true);
                return bb.toBuffer();
            })();
        const levelName = client.currentLevel;
        const levelScope = getClientLevelScope(client);
        const destroyedEntity =
            client.entities.get(entityId) ??
            (levelScope ? GlobalState.levelEntities.get(levelScope)?.get(entityId) : null);
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

        if (shouldProcessDefeatState && destroyedEntity && !destroyedEntity.isPlayer) {
            const authorityToken = resolveSharedDungeonProgressAuthorityToken(levelScope);
            const authorityClient = authorityToken > 0 ? GlobalState.sessionsByToken.get(authorityToken) : null;
            const completionClient = authorityClient && areClientsInSameLevelScope(client, authorityClient)
                ? authorityClient
                : client;
            CombatHandler.fireAndForgetMissionWork(
                client,
                'forced dungeon objective completion',
                () => MissionHandler.handleForcedDungeonObjectiveCompletion(completionClient, destroyedEntity)
            );
        }

        if (shouldRelayDestroy) {
            CombatHandler.broadcastToSameLevel(levelScope, 0x0D, destroyPayload, [], client);
        } else if (shouldMirrorClientSpawnEntity) {
            CombatHandler.relayPartyLocalEntityDefeat(client, levelScope, entityId);
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
        const entId = br.readMethod9();
        const clientHealAmount = Math.max(0, Math.round(br.readMethod24()));
        const usedPotion = br.readMethod15();
        if (usedPotion) {
            CombatHandler.tryConsumeRespawnPotion(client);
        }

        const isSelfRespawn = entId === client.clientEntID;
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
            const levelEntity = CombatHandler.resolveLevelEntity(getClientLevelScope(client), entId);
            if (levelEntity && typeof levelEntity === 'object') {
                levelEntity.dead = false;
                levelEntity.entState = EntityState.ACTIVE;
                levelEntity.hp = healAmount;
                levelEntity.maxHp = Math.max(Math.round(Number(levelEntity.maxHp ?? 0)), healAmount);
                levelEntity.lastCombatActivityAt = 0;
                levelEntity.lastCombatRegenTickAt = 0;
            }
        }

        const levelScope = getClientLevelScope(client);
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
        const targetEntity = entity ?? levelEntity;
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
            CombatHandler.logBossRegen('boss-hp-report-skip', levelScope, targetEntity, {
                reason: 'no-health',
                rawEntityId,
                entityId,
                amount,
                player: String(client.character?.name ?? 'unknown').replace(/\s+/g, '_')
            });
            return true;
        }

        const authoritativeKill = healthState.authoritativeKill &&
            !CombatHandler.shouldDeferPowerHitKillToClient(levelScope, targetEntity);
        const wasAlive = !Boolean(targetEntity.dead) &&
            Number(targetEntity.entState ?? EntityState.ACTIVE) !== EntityState.DEAD &&
            healthState.currentHp > 0;
        const minHp = authoritativeKill ? 0 : 1;
        const nextHp = Math.max(minHp, Math.min(healthState.maxHp, healthState.currentHp + amount));

        if (amount < 0) {
            const nowMs = Date.now();
            for (const copy of CombatHandler.collectHostileHealthCopies(levelScope, targetEntity)) {
                CombatHandler.setEntityCombatActivity(copy, nowMs);
                CombatHandler.setEntityLastRegenTickAt(copy, 0);
            }
        }

        if (nextHp !== healthState.currentHp) {
            CombatHandler.applyNpcHealthState(targetEntity, healthState.maxHp, nextHp, authoritativeKill);
            CombatHandler.syncHostileHealthCopies(levelScope, targetEntity, nextHp, healthState.maxHp);
        }

        CombatHandler.logBossRegen('boss-hp-report', levelScope, targetEntity, {
            rawEntityId,
            entityId,
            amount,
            previousHp: healthState.currentHp,
            nextHp,
            maxHp: healthState.maxHp,
            authoritativeKill,
            player: String(client.character?.name ?? 'unknown').replace(/\s+/g, '_')
        }, 0);
        if (
            authoritativeKill &&
            wasAlive &&
            nextHp <= 0 &&
            MissionHandler.shouldCompleteDungeonFromBossHpReport(client, targetEntity)
        ) {
            CombatHandler.handleEnemyDefeatState(client, levelScope, entityId, targetEntity, { fromKillState: true });
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
            if (CombatHandler.recordClientHostileHpDelta(client, levelScope, rawEntityId, entityId, entity, amount)) {
                return;
            }
            CombatHandler.logPlayerHp('client-hp-ignored', client, {
                reason: 'not-own-player',
                rawEntityId,
                entityId,
                amount,
                entityHp: Math.round(Number(entity?.hp ?? 0)),
                authHp: Math.round(Number(client.authoritativeCurrentHp ?? 0)),
                authMax: Math.round(Number(client.authoritativeMaxHp ?? 0))
            }, CombatHandler.PLAYER_HP_LOG_THROTTLE_MS);
            return;
        }

        const levelEntity = CombatHandler.resolveLevelEntity(levelScope, entityId);
        const maxHp = CombatHandler.resolvePlayerMaxHp(client, entity, levelEntity);
        const currentHp = CombatHandler.resolvePlayerCurrentHp(client, entity, levelEntity, maxHp);
        const nextHp = Math.max(0, Math.min(maxHp, currentHp + amount));
        CombatHandler.logPlayerHp('client-hp-report', client, {
            rawEntityId,
            entityId,
            amount,
            previousHp: currentHp,
            nextHp,
            maxHp,
            entityHp: Math.round(Number(entity?.hp ?? 0)),
            levelHp: Math.round(Number(levelEntity?.hp ?? 0)),
            authHp: Math.round(Number(client.authoritativeCurrentHp ?? 0)),
            authMax: Math.round(Number(client.authoritativeMaxHp ?? 0)),
            lastCombatAt: Math.max(0, client.lastCombatActivityAt),
            lastTickAt: Math.max(0, client.lastCombatRegenTickAt)
        });
        if (nextHp <= 0) {
            CombatHandler.notePlayerDeathState(client);
            CombatHandler.logPlayerHp('client-hp-death', client, {
                rawEntityId,
                entityId,
                amount,
                previousHp: currentHp,
                nextHp,
                maxHp
            });
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
        if (amount < 0) {
            CombatHandler.notePlayerDamageTakenActivity(client, Date.now());
            CombatHandler.logPlayerHp('damage-timer-start', client, {
                currentHp: nextHp,
                maxHp,
                damage: Math.abs(amount),
                lastCombatAt: Math.max(0, client.lastCombatActivityAt),
                lastTickAt: Math.max(0, client.lastCombatRegenTickAt)
            });
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
        info.targetId = EntityHandler.resolveEntityAlias(client, rawTargetId);
        info.sourceId = EntityHandler.resolveEntityAlias(client, rawSourceId);

        const { targetId, sourceId, damage } = info;
        const levelScope = getClientLevelScope(client);
        const targetEntity = CombatHandler.resolveLevelEntity(levelScope, targetId);
        const sourceEntity = CombatHandler.resolveLevelEntity(levelScope, sourceId);
        const isHostileNpcSource = Boolean(
            sourceEntity &&
            !sourceEntity.isPlayer &&
            Number(sourceEntity.team ?? 0) === EntityTeam.ENEMY
        );
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
        const resolution = CombatHandler.updateNpcTargetAfterHit(levelScope, targetId, damage);
        if (resolution.killed && resolution.entity && !deferDungeonCompletionUntilDestroy) {
            CombatHandler.handleEnemyDefeatState(sourceSession ?? client, levelScope, targetId, resolution.entity);
        }

        const relayPayload = info.targetId === rawTargetId && info.sourceId === rawSourceId
            ? data
            : CombatHandler.buildBuffTickDotPayload(info);

        CombatHandler.broadcastCombatPacket(client, 0x79, relayPayload, {
            referencedEntityIds: [targetId, sourceId]
        });
    }

    static async handleAddBuff(client: Client, data: Buffer): Promise<void> {
        CombatHandler.broadcastCombatPacket(client, 0x0B, data, {
            referencedEntityIds: CombatHandler.parseReferencedEntityIds(0x0B, data)
        });
    }

    static async handleRemoveBuff(client: Client, data: Buffer): Promise<void> {
        CombatHandler.broadcastCombatPacket(client, 0x0C, data, {
            referencedEntityIds: CombatHandler.parseReferencedEntityIds(0x0C, data)
        });
    }
}
