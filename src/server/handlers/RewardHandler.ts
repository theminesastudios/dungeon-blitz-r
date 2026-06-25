import { Client } from '../core/Client';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { noteDungeonRunChestOpened, noteDungeonRunTreasure } from '../core/DungeonRunStats';
import { CombatHandler } from './CombatHandler';
import { getClientCharacterKey, getPartyIdForClient } from '../core/PartySync';
import { areClientsInSameLevelScope, getClientLevelScope, getScopeLevelName } from '../core/LevelScope';
import { LevelConfig } from '../core/LevelConfig';
import { upsertInventoryGear } from '../utils/GearInventory';
import { getEquippedCharmBonuses } from '../utils/CharmBonuses';
import { getEquippedGearGoldFind } from '../utils/GearGoldBonuses';
import { getActivePotionBonuses } from '../utils/ConsumableState';
import { normalizeCharacterMaterials } from '../utils/MaterialInventory';
import { PetHandler } from './PetHandler';
import { Config } from '../core/config';
import { EntityHandler } from './EntityHandler';

interface RewardRequest {
    receiverId: number;
    sourceId: number;
    dropItem: boolean;
    itemMultiplier: number;
    dropGear: boolean;
    gearMultiplier: number; // Legacy packet field; client fills this with material-find multiplier.
    dropMaterial: boolean;
    dropTrove: boolean;
    exp: number;
    petExp: number;
    hpGain: number;
    gold: number;
    worldX: number;
    worldY: number;
    combo: number;
}

interface LootReward {
    gold?: number;
    health?: number;
    gear?: number;
    tier?: number;
    material?: number;
    dye?: number;
    __lootDropMetadata?: LootDropServerMetadata;
}

type LootDropServerMetadata = {
    lootdropId: number;
    lootDropNonce: string;
    sourceEnemyLootDropNonce: string;
    sourceEnemyCanonicalId: number;
    ownerToken: number;
    partyId: number;
    sharedScope: string;
    amount: number;
    type: string;
    reason: string;
    caller: string;
    collected: boolean;
    collectedBy: number;
};

type LootReason =
    | 'canonical_hostile_death'
    | 'quest_reward'
    | 'chest_reward'
    | 'debug'
    | 'legacy_enemy_reward'
    | 'unknown';

type LootGrantContext = {
    sourceLootDropNonce?: string;
    sourceEnemyCanonicalId?: number;
    reason?: LootReason;
    caller?: string;
};

type XpRewardDebug = {
    attempted: boolean;
    packetExp: number;
    baseExp: number;
    petBonus: number;
    potionBonus: number;
    totalBonusRate: number;
    multiplier: number;
    finalExp: number;
};

export class RewardHandler {
    private static nextLootId = 900000;
    private static readonly MATERIAL_DROP_CHANCE_BY_RANK: Record<string, number> = {
        Minion: 0.03,
        Lieutenant: 0.15,
        MiniBoss: 0.5,
        Boss: 1
    };
    private static readonly GEAR_DROP_CHANCE_BY_RANK: Record<string, number> = {
        Lieutenant: 0.03,
        MiniBoss: 0.10,
        Boss: 1
    };
    private static readonly DYE_DROP_CHANCE = 0.01;
    private static readonly MATERIAL_RARITY_WEIGHTS_NORMAL: Array<{ rarity: 'M' | 'R' | 'L'; weight: number }> = [
        { rarity: 'M', weight: 0.82 },
        { rarity: 'R', weight: 0.15 },
        { rarity: 'L', weight: 0.03 }
    ];
    private static readonly MATERIAL_RARITY_WEIGHTS_HARD: Array<{ rarity: 'M' | 'R' | 'L'; weight: number }> = [
        { rarity: 'M', weight: 0.62 },
        { rarity: 'R', weight: 0.32 },
        { rarity: 'L', weight: 0.06 }
    ];
    private static readonly DYE_RARITY_WEIGHTS_NORMAL: Array<{ rarity: 'M' | 'R'; weight: number }> = [
        { rarity: 'M', weight: 0.95 },
        { rarity: 'R', weight: 0.05 }
    ];
    private static readonly DYE_RARITY_WEIGHTS_HARD: Array<{ rarity: 'M' | 'R' | 'L'; weight: number }> = [
        { rarity: 'M', weight: 0.72 },
        { rarity: 'R', weight: 0.20 },
        { rarity: 'L', weight: 0.08 }
    ];
    private static readonly GEAR_RARITY_WEIGHTS_NORMAL: Array<{ tier: 0 | 1 | 2; weight: number }> = [
        { tier: 0, weight: 1 },
        { tier: 1, weight: 0 },
        { tier: 2, weight: 0 }
    ];
    private static readonly GEAR_RARITY_WEIGHTS_HARD: Array<{ tier: 0 | 1 | 2; weight: number }> = [
        { tier: 0, weight: 0.65 },
        { tier: 1, weight: 0.30 },
        { tier: 2, weight: 0.05 }
    ];
    private static readonly GEAR_RARITY_WEIGHTS_NORMAL_BY_RANK: Record<string, Array<{ tier: 0 | 1 | 2; weight: number }>> = {
        Lieutenant: [
            { tier: 0, weight: 1 - ((1 / 250) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.Lieutenant) },
            { tier: 1, weight: (1 / 250) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.Lieutenant },
            { tier: 2, weight: 0 }
        ],
        MiniBoss: [
            { tier: 0, weight: 1 - ((1 / 60) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.MiniBoss) },
            { tier: 1, weight: (1 / 60) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.MiniBoss },
            { tier: 2, weight: 0 }
        ],
        Boss: [
            { tier: 0, weight: 1 - ((1 / 15) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.Boss) },
            { tier: 1, weight: (1 / 15) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.Boss },
            { tier: 2, weight: 0 }
        ]
    };
    private static readonly GEAR_RARITY_WEIGHTS_HARD_BY_RANK: Record<string, Array<{ tier: 0 | 1 | 2; weight: number }>> = {
        Lieutenant: [
            { tier: 0, weight: 1 - ((1 / 100) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.Lieutenant) - ((1 / 333) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.Lieutenant) },
            { tier: 1, weight: (1 / 100) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.Lieutenant },
            { tier: 2, weight: (1 / 333) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.Lieutenant }
        ],
        MiniBoss: [
            { tier: 0, weight: 1 - ((1 / 40) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.MiniBoss) - ((1 / 100) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.MiniBoss) },
            { tier: 1, weight: (1 / 40) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.MiniBoss },
            { tier: 2, weight: (1 / 100) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.MiniBoss }
        ],
        Boss: [
            { tier: 0, weight: 1 - ((1 / 5) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.Boss) - ((1 / 25) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.Boss) },
            { tier: 1, weight: (1 / 5) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.Boss },
            { tier: 2, weight: (1 / 25) / RewardHandler.GEAR_DROP_CHANCE_BY_RANK.Boss }
        ]
    };
    private static readonly DUNGEON_REALM_MAP: Record<string, string> = {
        GoblinRiverDungeon: 'Goblin',
        GoblinRiverDungeonHard: 'Goblin',
        DreamDragonDungeon: 'Ghost',
        DreamDragonDungeonHard: 'Ghost',
        GoblinMineDungeon: 'Goblin',
        GoblinMineDungeonHard: 'Goblin',
        SwampCaveDungeon: 'Devourer',
        SwampCaveDungeonHard: 'Devourer',
        SpiderNestDungeon: 'Spider',
        SpiderNestDungeonHard: 'Spider',
        WyrmCaveDungeon: 'Wyrm',
        WyrmCaveDungeonHard: 'Wyrm',
        WolfDenDungeon: 'Wolf',
        WolfDenDungeonHard: 'Wolf',
        SkeletonCryptDungeon: 'Skeleton',
        SkeletonCryptDungeonHard: 'Skeleton',
        LizardTempleDungeon: 'Lizard',
        LizardTempleDungeonHard: 'Lizard',
        MummyTombDungeon: 'Mummy',
        MummyTombDungeonHard: 'Mummy'
    };

    private static buildLootdrop(
        lootId: number,
        x: number,
        y: number,
        reward: LootReward
    ): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(lootId);
        bb.writeMethod45(Math.round(x));
        bb.writeMethod45(Math.round(y));

        if (reward.gear && reward.gear > 0) {
            bb.writeMethod15(true);
            bb.writeMethod6(reward.gear, 11);
            bb.writeMethod6(reward.tier ?? 0, 2);
            return bb.toBuffer();
        }
        bb.writeMethod15(false);

        if (reward.material && reward.material > 0) {
            bb.writeMethod15(true);
            bb.writeMethod4(reward.material);
            return bb.toBuffer();
        }
        bb.writeMethod15(false);

        if (reward.gold && reward.gold > 0) {
            bb.writeMethod15(true);
            bb.writeMethod4(reward.gold);
            return bb.toBuffer();
        }
        bb.writeMethod15(false);

        if (reward.health && reward.health > 0) {
            bb.writeMethod15(true);
            bb.writeMethod4(reward.health);
            return bb.toBuffer();
        }
        bb.writeMethod15(false);

        bb.writeMethod15(false);
        bb.writeMethod4(reward.dye ?? 0);
        return bb.toBuffer();
    }

    private static sendXpReward(client: Client, amount: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(amount);
        client.sendBitBuffer(0x2B, bb);
    }

    public static sendGoldReward(client: Client, amount: number, suppress: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(amount);
        bb.writeMethod15(suppress);
        client.sendBitBuffer(0x35, bb);
    }

    private static sendGearReward(client: Client, gearId: number, tier: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(gearId, 11);
        bb.writeMethod6(tier, 2);
        client.sendBitBuffer(0x33, bb);
    }

    private static sendMaterialReward(client: Client, materialId: number, amount: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(materialId);
        bb.writeMethod4(amount);
        client.sendBitBuffer(0x34, bb);
    }

    private static sendDyeReward(client: Client, dyeId: number, suppress: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(dyeId, 8);
        bb.writeMethod15(suppress);
        client.sendBitBuffer(0x10A, bb);
    }

    private static sendEntityHeal(client: Client, entityId: number, amount: number): void {
        if (entityId <= 0 || amount <= 0) {
            return;
        }
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(amount);
        client.sendBitBuffer(0x78, bb);
    }

    private static resolveSourceEntity(client: Client, sourceId: number): any {
        if (client.entities.has(sourceId)) {
            return client.entities.get(sourceId);
        }
        const levelMap = client.currentLevel ? GlobalState.levelEntities.get(getClientLevelScope(client)) : null;
        return levelMap?.get(sourceId) ?? null;
    }

    private static resolveDropPosition(_client: Client, sourceEntity: any, fallbackX: number, fallbackY: number): { x: number; y: number } {
        const entityX = Number(sourceEntity?.x ?? sourceEntity?.pos_x ?? 0);
        const entityY = Number(sourceEntity?.y ?? sourceEntity?.pos_y ?? 0);
        // The client already projects reward packet coordinates onto the floor before sending them.
        const x = Number.isFinite(fallbackX) ? fallbackX : entityX;
        const y = Number.isFinite(fallbackY) ? fallbackY : entityY;
        return {
            x: Math.round(Number.isFinite(x) ? x : 0),
            y: Math.round(Number.isFinite(y) ? y : 0)
        };
    }

    private static pickWeighted<T extends string | number>(
        weights: Array<{ value: T; weight: number }>
    ): T {
        let roll = Math.random();
        for (const entry of weights) {
            roll -= entry.weight;
            if (roll < 0) {
                return entry.value;
            }
        }
        return weights[weights.length - 1]!.value;
    }

    private static pickWeightedWithRoll<T extends string | number>(
        weights: Array<{ value: T; weight: number }>
    ): { value: T; roll: number } {
        const roll = Math.random();
        let remaining = roll;
        for (const entry of weights) {
            remaining -= entry.weight;
            if (remaining < 0) {
                return { value: entry.value, roll };
            }
        }
        return { value: weights[weights.length - 1]!.value, roll };
    }

    private static getGearRarityWeights(client: Client, entRank: string): Array<{ tier: 0 | 1 | 2; weight: number }> {
        const rankWeights = RewardHandler.isHardDungeon(client.currentLevel)
            ? RewardHandler.GEAR_RARITY_WEIGHTS_HARD_BY_RANK[entRank]
            : RewardHandler.GEAR_RARITY_WEIGHTS_NORMAL_BY_RANK[entRank];

        return rankWeights ?? (
            RewardHandler.isHardDungeon(client.currentLevel)
                ? RewardHandler.GEAR_RARITY_WEIGHTS_HARD
                : RewardHandler.GEAR_RARITY_WEIGHTS_NORMAL
        );
    }

    private static resolveGearTier(client: Client, entRank: string): number {
        const weights = RewardHandler.getGearRarityWeights(client, entRank);
        return RewardHandler.pickWeighted<number>(weights.map((entry) => ({
            value: entry.tier,
            weight: entry.weight
        })));
    }

    private static resolveGearTierDebug(client: Client, entRank: string): {
        tier: number;
        tierRoll: number | null;
        tierWeights: Array<{ tier: number; weight: number }>;
    } {
        const tierWeights = RewardHandler.getGearRarityWeights(client, entRank);
        const weights = tierWeights.map((entry) => ({
            value: entry.tier,
            weight: entry.weight
        }));
        const result = RewardHandler.pickWeightedWithRoll<number>(weights);
        return {
            tier: result.value,
            tierRoll: result.roll,
            tierWeights
        };
    }

    private static getGearTierWeights(client: Client, entRank: string): Array<{ tier: number; weight: number }> {
        return RewardHandler.getGearRarityWeights(client, entRank);
    }

    private static sanitizeDropMultiplier(value: number | undefined): number {
        return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 1;
    }

    private static resolveMaterialDropChance(entType: any, reward: RewardRequest): number {
        const rank = String(entType?.EntRank ?? 'Minion');
        const baseChance = RewardHandler.MATERIAL_DROP_CHANCE_BY_RANK[rank] ?? RewardHandler.MATERIAL_DROP_CHANCE_BY_RANK.Minion;
        const multiplier = RewardHandler.sanitizeDropMultiplier(reward.gearMultiplier);
        return Math.max(0, Math.min(1, baseChance * multiplier));
    }

    private static resolveGearDropChance(entType: any, reward: RewardRequest): number {
        const rawChance = Number(entType?.ItemDropChance ?? 0);
        if (rawChance <= 0) {
            return 0;
        }

        const multiplier = RewardHandler.sanitizeDropMultiplier(reward.itemMultiplier);
        return Math.max(0, Math.min(1, rawChance * multiplier));
    }

    private static resolveMaterialDropRarity(client: Client): 'M' | 'R' | 'L' {
        const table = RewardHandler.isHardDungeon(client.currentLevel)
            ? RewardHandler.MATERIAL_RARITY_WEIGHTS_HARD
            : RewardHandler.MATERIAL_RARITY_WEIGHTS_NORMAL;
        return RewardHandler.pickWeighted<'M' | 'R' | 'L'>(table.map((entry) => ({
            value: entry.rarity,
            weight: entry.weight
        })));
    }

    private static resolveMaterialDropRarityDebug(client: Client): {
        rarity: 'M' | 'R' | 'L';
        rarityRoll: number;
        rarityWeights: Array<{ rarity: 'M' | 'R' | 'L'; weight: number }>;
    } {
        const table = RewardHandler.isHardDungeon(client.currentLevel)
            ? RewardHandler.MATERIAL_RARITY_WEIGHTS_HARD
            : RewardHandler.MATERIAL_RARITY_WEIGHTS_NORMAL;
        const result = RewardHandler.pickWeightedWithRoll<'M' | 'R' | 'L'>(table.map((entry) => ({
            value: entry.rarity,
            weight: entry.weight
        })));
        return {
            rarity: result.value,
            rarityRoll: result.roll,
            rarityWeights: table
        };
    }

    private static getMaterialRarityWeights(client: Client): Array<{ rarity: 'M' | 'R' | 'L'; weight: number }> {
        return RewardHandler.isHardDungeon(client.currentLevel)
            ? RewardHandler.MATERIAL_RARITY_WEIGHTS_HARD
            : RewardHandler.MATERIAL_RARITY_WEIGHTS_NORMAL;
    }

    private static getDyeRarityWeights(client: Client): Array<{ rarity: 'M' | 'R' | 'L'; weight: number }> {
        return RewardHandler.isHardDungeon(client.currentLevel)
            ? RewardHandler.DYE_RARITY_WEIGHTS_HARD
            : [
                { rarity: 'M', weight: 0.95 },
                { rarity: 'R', weight: 0.05 },
                { rarity: 'L', weight: 0 }
            ];
    }

    private static resolveDyeDropRarityDebug(client: Client, entType: any): {
        eligible: boolean;
        baseChance: number;
        finalChance: number;
        dropRoll: number | null;
        dropped: boolean;
        rarity: 'M' | 'R' | 'L' | null;
        rarityRoll: number | null;
        rarityWeights: Array<{ rarity: 'M' | 'R' | 'L'; weight: number }>;
    } {
        const rank = String(entType?.EntRank ?? 'Minion');
        const eligible = rank === 'Lieutenant' || rank === 'MiniBoss' || rank === 'Boss';
        const rarityWeights = RewardHandler.getDyeRarityWeights(client);
        if (!eligible) {
            return {
                eligible,
                baseChance: 0,
                finalChance: 0,
                dropRoll: null,
                dropped: false,
                rarity: null,
                rarityRoll: null,
                rarityWeights
            };
        }

        const dropRoll = Math.random();
        if (dropRoll >= RewardHandler.DYE_DROP_CHANCE) {
            return {
                eligible,
                baseChance: RewardHandler.DYE_DROP_CHANCE,
                finalChance: RewardHandler.DYE_DROP_CHANCE,
                dropRoll,
                dropped: false,
                rarity: null,
                rarityRoll: null,
                rarityWeights
            };
        }

        const rarityResult = RewardHandler.pickWeightedWithRoll<'M' | 'R' | 'L'>(rarityWeights.map((entry) => ({
            value: entry.rarity,
            weight: entry.weight
        })));
        return {
            eligible,
            baseChance: RewardHandler.DYE_DROP_CHANCE,
            finalChance: RewardHandler.DYE_DROP_CHANCE,
            dropRoll,
            dropped: true,
            rarity: rarityResult.value,
            rarityRoll: rarityResult.roll,
            rarityWeights
        };
    }

    private static buildRarityTotalChances(
        finalDropChance: number,
        weights: Array<{ rarity: string; weight: number }>
    ): Record<string, number> {
        const totals: Record<string, number> = {};
        for (const entry of weights) {
            totals[entry.rarity] = Math.max(0, Math.min(1, finalDropChance * entry.weight));
        }
        return totals;
    }

    private static buildTierTotalChances(
        finalDropChance: number,
        weights: Array<{ tier: number; weight: number }>
    ): Record<string, number> {
        const totals: Record<string, number> = {};
        for (const entry of weights) {
            totals[`tier${entry.tier}`] = Math.max(0, Math.min(1, finalDropChance * entry.weight));
        }
        return totals;
    }

    private static rewardClassAllowsItemLoot(entType: any): boolean {
        const rewardClass = String(entType?.RewardClass ?? '').trim();
        return Boolean(rewardClass)
            && rewardClass !== 'ExpAndGold'
            && rewardClass !== 'NoLoot'
            && rewardClass !== 'HealthOnly';
    }

    private static isHardDungeon(levelName: string | null | undefined): boolean {
        return /Hard$/i.test(String(levelName ?? '').trim());
    }

    private static isDungeonLevel(levelName: string | null | undefined): boolean {
        const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
        return LevelConfig.isDungeonLevel(normalizedLevel) || Boolean(RewardHandler.DUNGEON_REALM_MAP[normalizedLevel]);
    }

    private static getRewardType(reward: LootReward): string {
        if (reward.gold && reward.gold > 0) return 'gold';
        if (reward.health && reward.health > 0) return 'health';
        if (reward.gear && reward.gear > 0) return 'gear';
        if (reward.material && reward.material > 0) return 'material';
        if (reward.dye && reward.dye > 0) return 'dye';
        return 'unknown';
    }

    private static getRewardAmount(reward: LootReward): number {
        if (reward.gold && reward.gold > 0) return reward.gold;
        if (reward.health && reward.health > 0) return reward.health;
        if (reward.gear && reward.gear > 0) return reward.gear;
        if (reward.material && reward.material > 0) return reward.material;
        if (reward.dye && reward.dye > 0) return reward.dye;
        return 0;
    }

    private static getCanonicalLootSource(metadata: LootDropServerMetadata | undefined): any {
        if (!metadata?.sharedScope || metadata.sourceEnemyCanonicalId <= 0) {
            return null;
        }

        return GlobalState.levelEntities.get(metadata.sharedScope)?.get(metadata.sourceEnemyCanonicalId) ?? null;
    }

    private static normalizeNumberSet(value: unknown): Set<number> {
        if (value instanceof Set) {
            return new Set<number>(Array.from(value).map((entry) => Math.round(Number(entry) || 0)).filter((entry) => entry > 0));
        }
        if (Array.isArray(value)) {
            return new Set<number>(value.map((entry) => Math.round(Number(entry) || 0)).filter((entry) => entry > 0));
        }
        return new Set<number>();
    }

    private static normalizeStringSet(value: unknown): Set<string> {
        if (value instanceof Set) {
            return new Set<string>(Array.from(value).map((entry) => String(entry)));
        }
        if (Array.isArray(value)) {
            return new Set<string>(value.map((entry) => String(entry)));
        }
        return new Set<string>();
    }

    private static isEnemyLootReason(reason: string): boolean {
        return reason === 'canonical_hostile_death' || reason === 'legacy_enemy_reward';
    }

    private static isCanonicalDeathLootContextValid(
        levelScope: string,
        sourceEnemyCanonicalId: number,
        sourceEnemyLootDropNonce: string
    ): boolean {
        if (sourceEnemyCanonicalId <= 0 || !sourceEnemyLootDropNonce) {
            return false;
        }

        const canonicalEntity = GlobalState.levelEntities.get(levelScope)?.get(sourceEnemyCanonicalId);
        return Boolean(
            canonicalEntity &&
            canonicalEntity.dead === true &&
            canonicalEntity.destroyed === true &&
            Math.max(0, Math.round(Number(canonicalEntity.deathFinalizedAt ?? 0))) > 0 &&
            String(canonicalEntity.lootDropNonce ?? '') === sourceEnemyLootDropNonce
        );
    }

    private static isHostileRewardSource(sourceEntity: any): boolean {
        return Boolean(sourceEntity && !sourceEntity.isPlayer && Number(sourceEntity.team ?? 0) === 2);
    }

    private static getRewardSourceReason(sourceEntity: any): LootReason {
        if (RewardHandler.isHostileRewardSource(sourceEntity)) {
            return 'legacy_enemy_reward';
        }

        const entName = String(sourceEntity?.name ?? sourceEntity?.EntName ?? sourceEntity?.entName ?? '').trim();
        const entType = entName ? GameData.getEntType(entName) ?? {} : {};
        const behavior = String(entType.Behavior ?? sourceEntity?.behavior ?? sourceEntity?.Behavior ?? '').trim();
        if (/treasurechest/i.test(entName) || behavior === 'TreasureChest') {
            return 'chest_reward';
        }

        return 'unknown';
    }

    private static formatLootSyncFields(fields: Record<string, unknown>): string {
        return Object.entries(fields)
            .map(([key, value]) => `${key}=${String(value ?? '').replace(/\s+/g, '_')}`)
            .join(' ');
    }

    private static spawnLoot(
        client: Client,
        x: number,
        y: number,
        reward: LootReward,
        offsetX: number = 0,
        offsetY: number = 0,
        context: LootGrantContext = {}
    ): void {
        const lootId = ++RewardHandler.nextLootId;
        const type = RewardHandler.getRewardType(reward);
        const sourceEnemyLootDropNonce = String(context.sourceLootDropNonce ?? '');
        const sourceEnemyCanonicalId = Math.max(0, Math.round(Number(context.sourceEnemyCanonicalId ?? 0)));
        const reason = context.reason ?? 'unknown';
        const caller = String(context.caller ?? 'unknown');
        const levelScope = getClientLevelScope(client);
        const metadata: LootDropServerMetadata = {
            lootdropId: lootId,
            lootDropNonce: sourceEnemyLootDropNonce
                ? `${sourceEnemyLootDropNonce}:${client.token}:${lootId}`
                : `${levelScope}:loot:${client.token}:${lootId}`,
            sourceEnemyLootDropNonce,
            sourceEnemyCanonicalId,
            ownerToken: Math.max(0, Math.round(Number(client.token ?? 0))),
            partyId: Math.max(0, Math.round(Number(getPartyIdForClient(client) ?? 0))),
            sharedScope: levelScope,
            amount: RewardHandler.getRewardAmount(reward),
            type,
            reason,
            caller,
            collected: false,
            collectedBy: 0
        };
        CombatHandler.logLootSync('spawnLoot-callsite', {
            caller,
            viewer: client.character?.name ?? '',
            token: client.token,
            sourceEnemy: metadata.sourceEnemyCanonicalId,
            reason
        });
        const isServerAuthorityHostileLevel = EntityHandler.usesServerAuthorityHostiles(getScopeLevelName(levelScope));
        if (
            isServerAuthorityHostileLevel &&
            RewardHandler.isEnemyLootReason(reason) &&
            !RewardHandler.isCanonicalDeathLootContextValid(levelScope, metadata.sourceEnemyCanonicalId, metadata.sourceEnemyLootDropNonce)
        ) {
            CombatHandler.logLootSync('legacy-loot-blocked', {
                viewer: client.character?.name ?? '',
                token: client.token,
                scope: levelScope,
                sourceEnemy: metadata.sourceEnemyCanonicalId,
                reason: 'missing_canonical_death',
                caller
            });
            if (metadata.sourceEnemyCanonicalId === 0) {
                console.error(`[LootSync][ERROR-sourceEnemy-zero-hostile-loot] ${RewardHandler.formatLootSyncFields({
                    viewer: client.character?.name ?? '',
                    token: client.token,
                    scope: levelScope,
                    lootdropId: lootId,
                    caller
                })}`);
            }
            return;
        }
        const pendingReward: LootReward = { ...reward, __lootDropMetadata: metadata };
        client.pendingLoot.set(lootId, pendingReward);
        const sourceEntity = RewardHandler.getCanonicalLootSource(metadata);
        if (sourceEntity && typeof sourceEntity === 'object') {
            sourceEntity.lootDrops = sourceEntity.lootDrops instanceof Map ? sourceEntity.lootDrops : new Map<number, LootDropServerMetadata>();
            sourceEntity.lootDrops.set(lootId, metadata);
        }
        CombatHandler.logLootSync('loot-spawn-out', {
            viewer: client.character?.name ?? '',
            token: client.token,
            lootdropId: lootId,
            nonce: metadata.lootDropNonce,
            sourceEnemy: metadata.sourceEnemyCanonicalId,
            amount: metadata.amount,
            type,
            reason,
            caller
        });
        client.send(0x32, RewardHandler.buildLootdrop(lootId, x + offsetX, y + offsetY, reward));
    }

    private static resolveXpRewardDebug(client: Client, amount: number, packetExp: number = amount): XpRewardDebug {
        const petBonuses = PetHandler.getEquippedPetBonusRates(client.character);
        const potionBonuses = getActivePotionBonuses(client.character, client.currentLevel);
        const baseExp = Math.max(0, Math.round(Number(amount ?? 0)));
        const totalBonusRate = petBonuses.expBonus + potionBonuses.expBonus;
        return {
            attempted: baseExp > 0,
            packetExp: Math.max(0, Math.round(Number(packetExp ?? 0))),
            baseExp,
            petBonus: petBonuses.expBonus,
            potionBonus: potionBonuses.expBonus,
            totalBonusRate,
            multiplier: 1 + totalBonusRate,
            finalExp: Math.max(0, Math.round(baseExp * (1 + totalBonusRate)))
        };
    }

    private static applyXpReward(client: Client, amount: number): boolean {
        if (!client.character || amount <= 0) {
            return false;
        }

        const xpDebug = RewardHandler.resolveXpRewardDebug(client, amount);
        const totalAmount = xpDebug.finalExp;

        client.character.xp = Number(client.character.xp ?? 0) + totalAmount;
        client.character.level = GameData.getPlayerLevelFromXp(Number(client.character.xp ?? 0));
        RewardHandler.sendXpReward(client, totalAmount);
        PetHandler.applyActivePetExperience(client, totalAmount);
        return true;
    }

    private static collectOwnedGearTierKeys(client: Client): Set<string> {
        const owned = new Set<string>();
        const addGear = (gearId: unknown, tier: unknown): void => {
            const normalizedGearId = Number(gearId ?? 0);
            if (!Number.isFinite(normalizedGearId) || normalizedGearId <= 0) {
                return;
            }
            const normalizedTier = Math.max(0, Math.min(2, Math.round(Number(tier ?? 0) || 0)));
            for (let t = 0; t <= normalizedTier; t++) {
                owned.add(GameData.buildGearTierKey(normalizedGearId, t));
            }
        };

        for (const rawGear of Array.isArray(client.character?.inventoryGears) ? client.character.inventoryGears : []) {
            addGear(rawGear?.gearID, rawGear?.tier);
        }

        for (const rawGear of Array.isArray(client.character?.equippedGears) ? client.character.equippedGears : []) {
            addGear(rawGear?.gearID, rawGear?.tier);
        }

        for (const reward of client.pendingLoot.values()) {
            addGear(reward?.gear, reward?.tier ?? 0);
        }

        return owned;
    }

    private static collectOwnedDyeIds(client: Client): Set<number> {
        return new Set<number>(
            (Array.isArray(client.character?.OwnedDyes) ? client.character.OwnedDyes : [])
                .map((dye: unknown) => Number(dye))
                .filter((dyeId: number) => dyeId > 0)
                .map((dyeId: number) => Math.round(dyeId))
        );
    }

    private static maybeOverrideDungeonReward(client: Client, sourceEntity: any, reward: RewardRequest): {
        exp: number;
        gold: number;
        hpGain: number;
        materialId: number;
        gearId: number;
        gearTier: number;
        dyeId: number;
    } {
        let exp = reward.exp;
        let gold = reward.gold;
        const packetGold = gold;
        let hpGain = reward.hpGain;
        let materialId = 0;
        let gearId = 0;
        let gearTier = 0;
        let dyeId = 0;
        const petBonuses = PetHandler.getEquippedPetBonusRates(client.character);
        const potionBonuses = getActivePotionBonuses(client.character, client.currentLevel);
        const charmBonuses = getEquippedCharmBonuses(client.character);
        const gearGoldFind = getEquippedGearGoldFind(client.character);

        const entName = String(sourceEntity?.name ?? '');

        // Target Dummy (Hedefkuklası) - No rewards
        if (entName.startsWith('IntroDummy') || entName === 'EmperorDummy' || entName === 'EmperorDummyHard' || entName.startsWith('HomeDummy')) {
            return { exp: 0, gold: 0, hpGain: 0, materialId: 0, gearId: 0, gearTier: 0, dyeId: 0 };
        }

        const entType = entName ? GameData.getEntType(entName) : null;
        const entLevel = Math.max(1, Number(entType?.Level ?? 1));
        const playerClass = String(client.character?.class ?? '');
        const ownedGearTierKeys = RewardHandler.collectOwnedGearTierKeys(client);
        const realm = String(entType?.Realm ?? RewardHandler.DUNGEON_REALM_MAP[client.currentLevel] ?? '');
        const itemLootAllowedByClass = RewardHandler.rewardClassAllowsItemLoot(entType);
        const isDungeonLevel = RewardHandler.isDungeonLevel(client.currentLevel);
        const isDungeonEnemyReward = isDungeonLevel && Boolean(entName) && Boolean(entType) && sourceEntity && !sourceEntity.isPlayer;
        const entRank = String(entType?.EntRank ?? 'Minion');
        const isIntroEnemy = entName.startsWith('Intro');
        const isChainsEnemy = entName.startsWith('Chains');
        const isLargeEnemy = entRank === 'Lieutenant' || entRank === 'MiniBoss' || entRank === 'Boss';
        const allowItemDrop = !isChainsEnemy && (!isIntroEnemy || isLargeEnemy);
        const rewardClass = String(entType?.RewardClass ?? '');
        const shouldApplyDropTables = isDungeonEnemyReward &&
            allowItemDrop &&
            itemLootAllowedByClass;
        const baseMaterialChance = RewardHandler.MATERIAL_DROP_CHANCE_BY_RANK[entRank] ?? RewardHandler.MATERIAL_DROP_CHANCE_BY_RANK.Minion;
        const packetMaterialMultiplier = RewardHandler.sanitizeDropMultiplier(reward.gearMultiplier);
        const packetItemMultiplier = RewardHandler.sanitizeDropMultiplier(reward.itemMultiplier);
        const materialFindRate = petBonuses.craftFind + charmBonuses.craftFind + potionBonuses.craftFind;
        const itemFindRate = petBonuses.itemFind + charmBonuses.itemFind + potionBonuses.itemFind;
        const goldFindRate = petBonuses.goldFind + charmBonuses.goldFind + gearGoldFind + potionBonuses.goldFind;
        const shouldRollMaterial = shouldApplyDropTables && Boolean(realm);
        const shouldRollGear = shouldApplyDropTables;
        const materialChance = shouldRollMaterial
            ? RewardHandler.resolveMaterialDropChance(entType, reward)
            : 0;
        const gearChance = shouldRollGear
            ? RewardHandler.resolveGearDropChance(entType, reward)
            : 0;
        const dyeDebug = shouldApplyDropTables
            ? RewardHandler.resolveDyeDropRarityDebug(client, entType)
            : {
                eligible: false,
                baseChance: 0,
                finalChance: 0,
                dropRoll: null,
                dropped: false,
                rarity: null,
                rarityRoll: null,
                rarityWeights: RewardHandler.getDyeRarityWeights(client)
            };

        // Küçük Intro düşmanlar (Minion rank) ve Chains entitylerinden eşya düşmez
        let materialRoll: number | null = null;
        let materialRarity: 'M' | 'R' | 'L' | null = null;
        let materialRarityRoll: number | null = null;
        let materialRarityWeights = RewardHandler.getMaterialRarityWeights(client);
        if (realm && materialChance > 0) {
            materialRoll = Math.random();
            if (materialRoll < materialChance) {
                const rarityResult = RewardHandler.resolveMaterialDropRarityDebug(client);
                materialRarity = rarityResult.rarity;
                materialRarityRoll = rarityResult.rarityRoll;
                materialRarityWeights = rarityResult.rarityWeights;
                materialId = GameData.getRandomMaterialForRealm(realm, [materialRarity]);
            }
        }
        if (allowItemDrop && dyeDebug.rarity) {
            dyeId = GameData.getRandomDyeId([dyeDebug.rarity], RewardHandler.collectOwnedDyeIds(client));
        }
        let gearRoll: number | null = null;
        let gearTierRoll: number | null = null;
        let gearTierWeights = RewardHandler.getGearTierWeights(client, entRank);
        if (allowItemDrop && gearChance > 0) {
            gearRoll = Math.random();
            if (gearRoll < gearChance) {
                const tierResult = RewardHandler.resolveGearTierDebug(client, entRank);
                gearTier = tierResult.tier;
                gearTierRoll = tierResult.tierRoll;
                gearTierWeights = tierResult.tierWeights;
                gearId = GameData.getGearIdForEntity(
                    entName,
                    playerClass,
                    undefined,
                    client.currentLevel,
                    gearTier,
                    ownedGearTierKeys
                );
            }
        }
        let goldBeforeFind = gold;
        let goldAfterFind = gold;
        let goldFindApplied = false;
        if (gold > 0 && goldFindRate > 0) {
            goldFindApplied = true;
            goldAfterFind = Math.max(0, Math.round(gold * (1 + goldFindRate)));
            gold = goldAfterFind;
        }

        const xpDebug = RewardHandler.resolveXpRewardDebug(client, exp, reward.exp);
        const shouldLogRewardRoll = shouldRollMaterial || shouldRollGear || dyeDebug.eligible || packetGold > 0 || goldFindRate > 0 || xpDebug.attempted;
        if (Config.REWARD_ROLL_DEBUG && shouldLogRewardRoll) {
            console.log('[RewardRollDebug]', {
                character: client.character?.name ?? '',
                level: client.currentLevel,
                sourceId: reward.sourceId,
                receiverId: reward.receiverId,
                entName,
                entRank,
                rewardClass,
                playerClass,
                realm,
                allowItemDrop,
                itemLootAllowedByClass,
                rolls: {
                    material: {
                        attempted: shouldRollMaterial,
                        baseChance: baseMaterialChance,
                        packetMultiplier: packetMaterialMultiplier,
                        petFind: petBonuses.craftFind,
                        charmFind: charmBonuses.craftFind,
                        potionFind: potionBonuses.craftFind,
                        totalFindRate: materialFindRate,
                        finalMultiplier: packetMaterialMultiplier,
                        finalChance: materialChance,
                        dropRoll: materialRoll,
                        dropped: materialId > 0,
                        rarityWeights: materialRarityWeights,
                        rarityTotalChances: RewardHandler.buildRarityTotalChances(materialChance, materialRarityWeights),
                        rarityRoll: materialRarityRoll,
                        rarity: materialRarity,
                        materialId
                    },
                    gear: {
                        attempted: shouldRollGear,
                        baseChance: Number(entType?.ItemDropChance ?? 0),
                        packetMultiplier: packetItemMultiplier,
                        packetRawMultiplier: reward.itemMultiplier,
                        packetDropItem: reward.dropItem,
                        packetDropGear: reward.dropGear,
                        packetDropMaterial: reward.dropMaterial,
                        petFind: petBonuses.itemFind,
                        charmFind: charmBonuses.itemFind,
                        potionFind: potionBonuses.itemFind,
                        totalFindRate: itemFindRate,
                        finalMultiplier: packetItemMultiplier,
                        finalChance: gearChance,
                        dropRoll: gearRoll,
                        dropped: gearId > 0,
                        rarityWeights: gearTierWeights,
                        rarityTotalChances: RewardHandler.buildTierTotalChances(gearChance, gearTierWeights),
                        rarityRoll: gearTierRoll,
                        tier: gearId > 0 ? gearTier : null,
                        rolledTier: gearTierRoll !== null ? gearTier : null,
                        gearId
                    },
                    dye: {
                        attempted: dyeDebug.eligible,
                        baseChance: dyeDebug.baseChance,
                        finalChance: dyeDebug.finalChance,
                        rankEligible: dyeDebug.eligible,
                        affectedByFind: false,
                        blockedByItemDropRules: dyeDebug.dropped && !allowItemDrop,
                        dropRoll: dyeDebug.dropRoll,
                        dropped: dyeId > 0,
                        rarityWeights: dyeDebug.rarityWeights,
                        rarityTotalChances: RewardHandler.buildRarityTotalChances(dyeDebug.finalChance, dyeDebug.rarityWeights),
                        rarityRoll: dyeDebug.rarityRoll,
                        rarity: dyeId > 0 ? dyeDebug.rarity : null,
                        rolledRarityBeforeItemDropRules: dyeDebug.rarity,
                        dyeId
                    },
                    gold: {
                        attempted: packetGold > 0,
                        packetGold,
                        baseGold: goldBeforeFind,
                        petFind: petBonuses.goldFind,
                        charmFind: charmBonuses.goldFind,
                        gearFind: gearGoldFind,
                        potionFind: potionBonuses.goldFind,
                        totalFindRate: goldFindRate,
                        multiplier: 1 + goldFindRate,
                        findApplied: goldFindApplied,
                        finalGold: goldAfterFind
                    },
                    exp: {
                        attempted: xpDebug.attempted,
                        packetExp: xpDebug.packetExp,
                        baseExp: xpDebug.baseExp,
                        petBonus: xpDebug.petBonus,
                        potionBonus: xpDebug.potionBonus,
                        totalBonusRate: xpDebug.totalBonusRate,
                        multiplier: xpDebug.multiplier,
                        finalExp: xpDebug.finalExp
                    }
                }
            });
        }

        const needsFallback = gold <= 0 && !shouldRollGear && !shouldRollMaterial;
        if (!needsFallback) {
            return { exp, gold, hpGain, materialId, gearId, gearTier, dyeId };
        }

        if (exp <= 1 && entName) {
            exp = GameData.calculateNpcExp(entName, entLevel);
        }

        if (hpGain <= 0 && Math.random() < 0.20) {
            const maxHp = Math.max(100, Number(client.authoritativeMaxHp ?? 100));
            hpGain = Math.max(1, Math.floor(maxHp * 0.15));
        }

        const result = { exp, gold, hpGain, materialId, gearId, gearTier, dyeId };
        if (entName === 'IntroParrot' || entName.startsWith('Chains')) {
            result.exp = 0;
        }
        return result;
    }

    private static persistCharacter(client: Client, reason: string): void {
        if (!client.userId || !client.character) {
            return;
        }
        const characters = Array.isArray((client as Client & { characters?: unknown }).characters)
            ? client.characters
            : [];
        const index = characters.findIndex((entry) => entry.name === client.character?.name);
        if (index >= 0) {
            characters[index] = client.character;
        } else if (characters === client.characters) {
            characters.push(client.character);
        }
        if (typeof client.scheduleCharacterSave === 'function') {
            client.scheduleCharacterSave(reason);
        }
    }

    private static findOnlineContributor(levelName: string, contributorKey: string): Client | null {
        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || !other.character || getClientLevelScope(other) !== levelName) {
                continue;
            }
            if (getClientCharacterKey(other) === contributorKey) {
                return other;
            }
        }

        return null;
    }

    private static addContributorRecipients(levelScope: string, contributor: Client, recipients: Map<string, Client>): void {
        const contributorKey = getClientCharacterKey(contributor);
        if (!contributor.character || !contributorKey) {
            return;
        }

        const contributorPartyId = getPartyIdForClient(contributor);
        if (contributorPartyId <= 0) {
            recipients.set(contributorKey, contributor);
            return;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (
                !other.playerSpawned ||
                !other.character ||
                getClientLevelScope(other) !== levelScope ||
                getPartyIdForClient(other) !== contributorPartyId
            ) {
                continue;
            }

            recipients.set(getClientCharacterKey(other), other);
        }
    }

    private static resolveEligibleRecipients(client: Client, sourceId: number): { rewardNonce: number; recipients: Client[] } {
        const scopeKey = getClientLevelScope(client);
        const snapshot = CombatHandler.getContributionSnapshot(scopeKey, sourceId);
        const recipients = new Map<string, Client>();

        for (const contributorKey of snapshot.contributors) {
            const contributor = RewardHandler.findOnlineContributor(scopeKey, contributorKey);
            if (!contributor?.character) {
                continue;
            }

            RewardHandler.addContributorRecipients(scopeKey, contributor, recipients);
        }

        if (!recipients.size && client.character) {
            recipients.set(getClientCharacterKey(client), client);
        }

        return {
            rewardNonce: snapshot.nonce,
            recipients: Array.from(recipients.values())
        };
    }

    private static applyRewardToRecipient(
        client: Client,
        reward: RewardRequest,
        rewardNonce: string | number,
        sourceEntity: any,
        dropPosition: { x: number; y: number },
        context: LootGrantContext = {}
    ): boolean {
        if (!client.character || !client.currentLevel) {
            return false;
        }

        const rewardKey = `${getClientLevelScope(client)}:${reward.sourceId}:${rewardNonce}`;
        if (client.processedRewardSources.has(rewardKey)) {
            if (context.sourceLootDropNonce) {
                CombatHandler.logLootSync('loot-grant-skip', {
                    canonicalId: context.sourceEnemyCanonicalId ?? reward.sourceId,
                    nonce: context.sourceLootDropNonce,
                    viewer: client.character?.name ?? '',
                    token: client.token,
                    reason: 'already_processed'
                });
            }
            return false;
        }
        client.processedRewardSources.add(rewardKey);

        const resolved = RewardHandler.maybeOverrideDungeonReward(client, sourceEntity, reward);
        const reason = context.reason ?? 'unknown';
        const caller = context.caller ?? 'unknown';
        if (context.sourceLootDropNonce) {
            CombatHandler.logLootSync('loot-grant', {
                canonicalId: context.sourceEnemyCanonicalId ?? reward.sourceId,
                nonce: context.sourceLootDropNonce,
                viewer: client.character?.name ?? '',
                token: client.token,
                amount: resolved.gold,
                reason,
                caller
            });
        }
        const shouldSave = RewardHandler.applyXpReward(client, resolved.exp);

        noteDungeonRunChestOpened(client, reward.sourceId, sourceEntity);

        if (resolved.gold > 0) {
            RewardHandler.spawnLoot(client, dropPosition.x, dropPosition.y, { gold: resolved.gold }, 0, 0, context);
        }
        if (resolved.hpGain > 0) {
            RewardHandler.spawnLoot(
                client,
                dropPosition.x,
                dropPosition.y,
                { health: resolved.hpGain },
                Math.floor(Math.random() * 31) - 15,
                Math.floor(Math.random() * 31) - 15,
                context
            );
        }
        if (resolved.gearId > 0) {
            RewardHandler.spawnLoot(
                client,
                dropPosition.x,
                dropPosition.y,
                { gear: resolved.gearId, tier: resolved.gearTier },
                Math.floor(Math.random() * 41) - 20,
                Math.floor(Math.random() * 21) - 10,
                context
            );
        }
        if (resolved.materialId > 0) {
            RewardHandler.spawnLoot(
                client,
                dropPosition.x,
                dropPosition.y,
                { material: resolved.materialId },
                Math.floor(Math.random() * 41) - 20,
                Math.floor(Math.random() * 21) - 10,
                context
            );
        }
        if (resolved.dyeId > 0) {
            RewardHandler.spawnLoot(
                client,
                dropPosition.x,
                dropPosition.y,
                { dye: resolved.dyeId },
                Math.floor(Math.random() * 41) - 20,
                Math.floor(Math.random() * 21) - 10,
                context
            );
        }

        if (shouldSave) {
            RewardHandler.persistCharacter(client, 'reward grant');
        }
        return true;
    }

    static handleGrantReward(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const reward: RewardRequest = {
            receiverId: br.readMethod9(),
            sourceId: br.readMethod9(),
            dropItem: br.readMethod15(),
            itemMultiplier: br.readMethod309(),
            dropGear: br.readMethod15(),
            gearMultiplier: br.readMethod309(),
            dropMaterial: br.readMethod15(),
            dropTrove: br.readMethod15(),
            exp: br.readMethod9(),
            petExp: br.readMethod9(),
            hpGain: br.readMethod9(),
            gold: br.readMethod9(),
            worldX: br.readMethod24(),
            worldY: br.readMethod24(),
            combo: br.readMethod15() ? br.readMethod9() : 0
        };

        if (!client.character || !client.currentLevel) {
            return;
        }

        const sourceEntity = RewardHandler.resolveSourceEntity(client, reward.sourceId);
        const dropPosition = RewardHandler.resolveDropPosition(client, sourceEntity, reward.worldX, reward.worldY);
        const { rewardNonce, recipients } = RewardHandler.resolveEligibleRecipients(client, reward.sourceId);
        const reason = RewardHandler.getRewardSourceReason(sourceEntity);
        const caller = 'handleGrantReward';
        const levelScope = getClientLevelScope(client);
        if (
            EntityHandler.usesServerAuthorityHostiles(client.currentLevel) &&
            reason === 'legacy_enemy_reward'
        ) {
            CombatHandler.logLootSync('spawnLoot-callsite', {
                caller,
                viewer: client.character?.name ?? '',
                token: client.token,
                sourceEnemy: 0,
                reason
            });
            CombatHandler.logLootSync('enemy-reward-blocked-no-canonical-context', {
                viewer: client.character?.name ?? '',
                token: client.token,
                scope: levelScope,
                caller
            });
            CombatHandler.logLootSync('legacy-loot-blocked', {
                viewer: client.character?.name ?? '',
                token: client.token,
                scope: levelScope,
                sourceEnemy: 0,
                reason: 'missing_canonical_death',
                caller
            });
            return;
        }

        for (const recipient of recipients) {
            if (!recipient.playerSpawned || !areClientsInSameLevelScope(client, recipient)) {
                continue;
            }

            RewardHandler.applyRewardToRecipient(recipient, reward, rewardNonce, sourceEntity, dropPosition, {
                reason,
                caller
            });
        }
    }

    private static resolveServerEnemyRewardViewers(client: Client, levelScope: string): Client[] {
        const partyId = getPartyIdForClient(client);
        if (partyId <= 0) {
            return client.character && client.playerSpawned && getClientLevelScope(client) === levelScope ? [client] : [];
        }

        const recipients: Client[] = [];
        for (const other of GlobalState.sessionsByToken.values()) {
            if (
                !other.playerSpawned ||
                !other.character ||
                getClientLevelScope(other) !== levelScope ||
                getPartyIdForClient(other) !== partyId
            ) {
                continue;
            }
            recipients.push(other);
        }

        return recipients;
    }

    static grantServerEnemyRewardToEligibleViewers(
        client: Client,
        sourceEntity: any,
        options: { levelScope?: string; lootDropNonce?: string | number; sourceEnemyCanonicalId?: number; caller?: string } = {}
    ): void {
        if (
            !client.character ||
            !client.currentLevel ||
            !sourceEntity ||
            sourceEntity.isPlayer ||
            Number(sourceEntity.team ?? 0) !== 2
        ) {
            return;
        }

        const sourceId = Math.max(0, Math.round(Number(sourceEntity.id ?? 0)));
        const entName = String(sourceEntity.name ?? sourceEntity.EntName ?? sourceEntity.entName ?? '').trim();
        if (sourceId <= 0 || !entName) {
            return;
        }

        const levelScope = String(options.levelScope ?? getClientLevelScope(client));
        const sourceEnemyCanonicalId = Math.max(0, Math.round(Number(options.sourceEnemyCanonicalId ?? 0)));
        const sourceLootDropNonce = String(options.lootDropNonce ?? '');
        const caller = String(options.caller ?? 'grantServerEnemyRewardToEligibleViewers');
        if (
            EntityHandler.usesServerAuthorityHostiles(getScopeLevelName(levelScope)) &&
            (
                sourceEnemyCanonicalId !== sourceId ||
                !RewardHandler.isCanonicalDeathLootContextValid(levelScope, sourceEnemyCanonicalId, sourceLootDropNonce)
            )
        ) {
            CombatHandler.logLootSync('enemy-reward-blocked-no-canonical-context', {
                viewer: client.character?.name ?? '',
                token: client.token,
                scope: levelScope,
                caller
            });
            return;
        }
        const entType = GameData.getEntType(entName) ?? {};
        const entLevel = Math.max(
            1,
            Math.round(Number(sourceEntity.level ?? entType.Level ?? client.character.level ?? 1) || 1)
        );
        const entRank = String(entType.EntRank ?? sourceEntity.entRank ?? sourceEntity.EntRank ?? 'Minion').trim();
        const maxHp = Math.max(100, Math.round(Number(client.authoritativeMaxHp ?? sourceEntity.maxHp ?? 100) || 100));
        const reward: RewardRequest = {
            receiverId: Math.max(0, Math.round(Number(client.clientEntID ?? 0))),
            sourceId,
            dropItem: true,
            itemMultiplier: 1,
            dropGear: true,
            gearMultiplier: 1,
            dropMaterial: true,
            dropTrove: false,
            exp: GameData.calculateNpcExp(entName, entLevel),
            petExp: 0,
            hpGain: entRank === 'Boss' || entRank === 'MiniBoss'
                ? Math.max(1, Math.floor(maxHp * 0.15))
                : 0,
            gold: GameData.calculateNpcGold(entName, entLevel),
            worldX: Math.round(Number(sourceEntity.x ?? sourceEntity.pos_x ?? 0) || 0),
            worldY: Math.round(Number(sourceEntity.y ?? sourceEntity.pos_y ?? 0) || 0),
            combo: 0
        };
        const dropPosition = RewardHandler.resolveDropPosition(client, sourceEntity, reward.worldX, reward.worldY);
        const recipients = RewardHandler.resolveServerEnemyRewardViewers(client, levelScope);
        sourceEntity.lootGrantedTokens = RewardHandler.normalizeNumberSet(sourceEntity.lootGrantedTokens);

        for (const recipient of recipients) {
            if (!recipient.playerSpawned || getClientLevelScope(recipient) !== levelScope) {
                continue;
            }
            if (sourceEntity.lootGrantedTokens.has(recipient.token)) {
                CombatHandler.logLootSync('loot-grant-skip', {
                    canonicalId: sourceId,
                    nonce: sourceLootDropNonce,
                    viewer: recipient.character?.name ?? '',
                    token: recipient.token,
                    reason: 'already_granted'
                });
                continue;
            }

            sourceEntity.lootGrantedTokens.add(recipient.token);
            RewardHandler.applyRewardToRecipient(recipient, reward, sourceLootDropNonce, sourceEntity, dropPosition, {
                sourceLootDropNonce,
                sourceEnemyCanonicalId: sourceId,
                reason: 'canonical_hostile_death',
                caller
            });
        }
    }

    static grantServerEnemyReward(client: Client, sourceEntity: any): void {
        RewardHandler.grantServerEnemyRewardToEligibleViewers(client, sourceEntity, {
            caller: 'grantServerEnemyReward'
        });
    }

    static handlePickupLootdrop(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const lootId = br.readMethod9();
        const reward = client.pendingLoot.get(lootId);
        if (!reward || !client.character) {
            return;
        }

        const metadata = reward.__lootDropMetadata;
        if (metadata) {
            if (metadata.ownerToken > 0 && metadata.ownerToken !== client.token) {
                CombatHandler.logLootSync('pickup-duplicate-drop', {
                    lootdropId: lootId,
                    nonce: metadata.lootDropNonce,
                    token: client.token,
                    reason: 'owner_mismatch'
                });
                client.pendingLoot.delete(lootId);
                return;
            }

            const sourceEntity = RewardHandler.getCanonicalLootSource(metadata);
            const collectedTokens = sourceEntity && typeof sourceEntity === 'object'
                ? RewardHandler.normalizeStringSet(sourceEntity.lootCollectedTokens)
                : new Set<string>();
            const collectKey = metadata.ownerToken > 0
                ? `${metadata.lootDropNonce}:${client.token}`
                : metadata.lootDropNonce;
            if (metadata.collected || collectedTokens.has(collectKey)) {
                CombatHandler.logLootSync('pickup-duplicate-drop', {
                    lootdropId: lootId,
                    nonce: metadata.lootDropNonce,
                    token: client.token,
                    reason: 'already_collected'
                });
                client.pendingLoot.delete(lootId);
                return;
            }

            metadata.collected = true;
            metadata.collectedBy = client.token;
            collectedTokens.add(collectKey);
            if (sourceEntity && typeof sourceEntity === 'object') {
                sourceEntity.lootCollectedTokens = collectedTokens;
            }
            CombatHandler.logLootSync('pickup', {
                lootdropId: lootId,
                nonce: metadata.lootDropNonce,
                token: client.token,
                amount: metadata.amount,
                reason: metadata.reason,
                caller: metadata.caller
            });
        } else {
            CombatHandler.logLootSync('pickup', {
                lootdropId: lootId,
                nonce: '',
                token: client.token,
                amount: RewardHandler.getRewardAmount(reward)
            });
        }

        client.pendingLoot.delete(lootId);

        let shouldSave = false;

        if (reward.gold && reward.gold > 0) {
            client.character.gold = Number(client.character.gold ?? 0) + reward.gold;
            noteDungeonRunTreasure(client, reward.gold);
            RewardHandler.sendGoldReward(client, reward.gold, false);
            shouldSave = true;
        }

        if (reward.material && reward.material > 0) {
            const materials = normalizeCharacterMaterials(client.character);
            const existing = materials.find((entry: any) => Number(entry.materialID ?? 0) === reward.material);
            if (existing) {
                existing.count = Number(existing.count ?? 0) + 1;
            } else {
                materials.push({ materialID: reward.material, count: 1 });
            }
            client.character.materials = materials;
            RewardHandler.sendMaterialReward(client, reward.material, 1);
            shouldSave = true;
        }

        if (reward.gear && reward.gear > 0) {
            const inserted = upsertInventoryGear(
                client.character,
                reward.gear,
                reward.tier ?? 0,
                [0, 0, 0],
                [0, 0]
            ).inserted;
            if (inserted) {
                RewardHandler.sendGearReward(client, reward.gear, reward.tier ?? 0);
                shouldSave = true;
            }
        }

        if (reward.health && reward.health > 0) {
            client.authoritativeCurrentHp = Math.min(
                Math.max(0, Number(client.authoritativeCurrentHp ?? reward.health) + reward.health),
                Math.max(1, Number(client.authoritativeMaxHp ?? 100))
            );
            RewardHandler.sendEntityHeal(client, client.clientEntID, reward.health);
        }

        if (reward.dye && reward.dye > 0) {
            const ownedDyes = new Set<number>(
                (Array.isArray(client.character.OwnedDyes) ? client.character.OwnedDyes : [])
                    .map((dye: unknown) => Number(dye))
                    .filter((dyeId: number) => dyeId > 0)
            );
            const existingCount = ownedDyes.size;
            ownedDyes.add(reward.dye);
            client.character.OwnedDyes = Array.from(ownedDyes.values()).sort((left, right) => left - right);
            RewardHandler.sendDyeReward(client, reward.dye, false);
            shouldSave = shouldSave || ownedDyes.size !== existingCount;
        }

        if (shouldSave) {
            RewardHandler.persistCharacter(client, 'loot pickup');
        }
    }
}
