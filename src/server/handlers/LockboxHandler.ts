import { Client } from '../core/Client';
import { GameData } from '../core/GameData';
import { PetConfig } from '../core/PetConfig';
import { JsonAdapter } from '../database/JsonAdapter';
import { WalletService } from '../database/WalletService';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { ensureSigilStoreAlertState } from '../utils/AlertState';
import { upsertInventoryGear } from '../utils/GearInventory';
import { PetHandler } from './PetHandler';
import { RewardHandler } from './RewardHandler';

const db = new JsonAdapter();

type LockboxRewardType = 'mount' | 'pet' | 'egg' | 'consumable' | 'gear' | 'charm' | 'gold' | 'dye';

interface LockboxRewardDefinition {
    index: number;
    name: string | null;
    type: LockboxRewardType;
    weight: number;
    goldAmount?: number;
}

interface ResolvedLockboxReward {
    index: number;
    type: LockboxRewardType;
    grantName: string;
    packetName: string;
    rarity: string;
    gearId?: number;
    goldAmount?: number;
    convertedFrom?: {
        index: number;
        type: LockboxRewardType;
        name: string;
        reason: string;
    };
    selectionDebug: {
        topLevelRoll: number;
        topLevelChancePercent: number;
        topLevelBandStartPercent: number;
        topLevelBandEndPercent: number;
        secondaryRoll?: number;
        secondaryChancePercent?: number;
        secondaryPoolSize?: number;
    };
}

interface LockboxRewardPoolSnapshot {
    rewards: LockboxRewardDefinition[];
    totalWeight: number;
}

interface WeightedRewardPick {
    reward: LockboxRewardDefinition;
    roll: number;
    bandStart: number;
    bandEnd: number;
    totalWeight: number;
}

export class LockboxHandler {
    private static readonly TROVE_LOCKBOX_ID = 1;
    private static readonly DUPLICATE_PET_FALLBACK_REWARD_NAME = 'PetFood';
    private static readonly TROVE_OPTIONS: Record<number, { quantity: number; cost: number }> = {
        0: { quantity: 1, cost: 50000 },
        1: { quantity: 10, cost: 375000 },
        2: { quantity: 25, cost: 625000 }
    };
    private static readonly KEY_OPTIONS: Record<number, { quantity: number; cost: number }> = {
        0: { quantity: 1, cost: 22 },
        1: { quantity: 10, cost: 210 },
        2: { quantity: 25, cost: 470 }
    };
    private static readonly LOCKBOX_REWARD_POOL: LockboxRewardDefinition[] = [
        { index: 0, name: 'MountLockbox01L01', type: 'mount', weight: 0.5 },
        { index: 1, name: 'Lockbox01L01', type: 'pet', weight: 1 },
        { index: 2, name: 'GenericBrown', type: 'egg', weight: 2.5 },
        { index: 3, name: 'CommonBrown', type: 'egg', weight: 2.5 },
        { index: 4, name: 'OrdinaryBrown', type: 'egg', weight: 2.5 },
        { index: 5, name: 'PlainBrown', type: 'egg', weight: 2.5 },
        { index: 6, name: 'RarePetFood', type: 'consumable', weight: 7 },
        { index: 7, name: 'PetFood', type: 'consumable', weight: 13 },
        { index: 8, name: null, type: 'gear', weight: 2.5 },
        { index: 9, name: 'TripleFind', type: 'charm', weight: 2 },
        { index: 10, name: 'DoubleFind1', type: 'charm', weight: 7 },
        { index: 11, name: 'DoubleFind2', type: 'charm', weight: 7 },
        { index: 12, name: 'DoubleFind3', type: 'charm', weight: 7 },
        { index: 13, name: 'MajorLegendaryCatalyst', type: 'consumable', weight: 4 },
        { index: 14, name: 'MajorRareCatalyst', type: 'consumable', weight: 8 },
        { index: 15, name: 'MinorRareCatalyst', type: 'consumable', weight: 12 },
        { index: 16, name: '1,000,000 Gold', type: 'gold', weight: 2, goldAmount: 1000000 },
        { index: 17, name: '500,000 Gold', type: 'gold', weight: 3, goldAmount: 500000 },
        { index: 18, name: '250,000 Gold', type: 'gold', weight: 9, goldAmount: 250000 },
        { index: 19, name: null, type: 'dye', weight: 5 }
    ];
    private static readonly CLASS_GEAR_IDS: Record<string, number[]> = {
        mage: [1165, 1166, 1167, 1168, 1169, 1170],
        rogue: [1171, 1172, 1173, 1174, 1175, 1176],
        paladin: [1177, 1178, 1179, 1180, 1181, 1182]
    };
    private static readonly CLASS_GEAR_NAMES: Record<number, string> = {
        1165: 'UniqueMageLockbox01GearSword30',
        1166: 'UniqueMageLockbox01GearShield30',
        1167: 'UniqueMageLockbox01GearHat30',
        1168: 'UniqueMageLockbox01GearArmor30',
        1169: 'UniqueMageLockbox01GearGloves30',
        1170: 'UniqueMageLockbox01GearBoots30',
        1171: 'UniqueRogueLockbox01GearSword30',
        1172: 'UniqueRogueLockbox01GearShield30',
        1173: 'UniqueRogueLockbox01GearHat30',
        1174: 'UniqueRogueLockbox01GearArmor30',
        1175: 'UniqueRogueLockbox01GearGloves30',
        1176: 'UniqueRogueLockbox01GearBoots30',
        1177: 'UniquePaladinLockbox01GearSword30',
        1178: 'UniquePaladinLockbox01GearShield30',
        1179: 'UniquePaladinLockbox01GearHat30',
        1180: 'UniquePaladinLockbox01GearArmor30',
        1181: 'UniquePaladinLockbox01GearGloves30',
        1182: 'UniquePaladinLockbox01GearBoots30'
    };
    private static readonly LEGENDARY_DYES = [
        'BroodMotherBlack',
        'ClearcastPearl',
        'WizardWoolWhite',
        'AstralObsidian',
        'GleamingGold',
        'ShiningSilver',
        'MightyMammothIvory',
        'FieryPhoenixFeather',
        'VelvetValkyries',
        'YearOfTheMammoth',
        'CheerocracyPackPink',
        'ElegantEmerald',
        'LeviathanLapisLazuli',
        'AlluringAmethyst',
        'SparklingTourmaline',
        'DragonCoatRed',
        'IridescentOpal',
        'HailToTheForest',
        'BrokenHeartBlack',
        'FrostlordSatin'
    ];

    static async handleBuyTreasureTrove(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        let optionIndex = 0;
        try {
            const br = new BitReader(data);
            br.readMethod6(2);
            optionIndex = br.readMethod4();
        } catch (error) {
            console.log(`[LockboxHandler] Failed to parse treasure trove purchase payload: ${String(error)}`);
            return;
        }

        const option = LockboxHandler.TROVE_OPTIONS[optionIndex];
        if (!option) {
            return;
        }

        const didApplyWallet = await WalletService.applyDelta(client, {
            gold: -option.cost,
            lockboxes: [{ lockboxID: LockboxHandler.TROVE_LOCKBOX_ID, delta: option.quantity }]
        });
        if (!didApplyWallet) {
            return;
        }

        LockboxHandler.sendGoldLoss(client, option.cost);
        LockboxHandler.sendLockboxInventoryDelta(client, LockboxHandler.TROVE_LOCKBOX_ID, option.quantity);
        await LockboxHandler.saveCharacter(client);
    }

    static async handleBuyLockboxKeys(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        let optionIndex = 0;
        try {
            const br = new BitReader(data);
            optionIndex = br.readMethod9();
        } catch (error) {
            console.log(`[LockboxHandler] Failed to parse Dragon Key purchase payload: ${String(error)}`);
            return;
        }

        const option = LockboxHandler.KEY_OPTIONS[optionIndex];
        if (!option) {
            return;
        }

        const didApplyWallet = await WalletService.applyDelta(client, {
            mammothIdols: -option.cost,
            DragonKeys: option.quantity
        });
        if (!didApplyWallet) {
            return;
        }

        LockboxHandler.sendIdolLoss(client, `DragonKeys_x${option.quantity}`, option.cost);
        await LockboxHandler.saveCharacter(client);
    }

    static async handleLockboxReward(client: Client, _data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const currentTroveCount = LockboxHandler.getLockboxCount(client.character, LockboxHandler.TROVE_LOCKBOX_ID);
        const currentKeys = Number(client.character.DragonKeys ?? 0);
        if (currentTroveCount <= 0 || currentKeys <= 0) {
            return;
        }

        const rewardPool = LockboxHandler.buildRewardPool(client.character);
        const reward = LockboxHandler.selectReward(client.character, rewardPool);
        const sigilReward = 50 + Math.floor(Math.random() * 101);
        const didApplyWallet = await WalletService.applyDelta(client, {
            DragonKeys: -1,
            SilverSigils: sigilReward,
            gold: reward.type === 'gold' ? Number(reward.goldAmount ?? 0) : 0,
            lockboxes: [{ lockboxID: LockboxHandler.TROVE_LOCKBOX_ID, delta: -1 }]
        });
        if (!didApplyWallet) {
            return;
        }

        LockboxHandler.sendLockboxReveal(client, reward);

        ensureSigilStoreAlertState(client.character);
        LockboxHandler.sendRoyalSigilReward(client, sigilReward);

        console.log(
            `[LockboxHandler] Treasure Trove opened by ${String(client.character.name ?? 'Unknown')}: ` +
            `rewardIndex=${reward.index} type=${reward.type} rarity=${reward.rarity} name="${reward.grantName}" ` +
            `gearId=${Number(reward.gearId ?? 0)} gold=${Number(reward.goldAmount ?? 0)} ` +
            (
                reward.convertedFrom
                    ? `convertedFrom=${reward.convertedFrom.type}:${reward.convertedFrom.index}:${reward.convertedFrom.reason} `
                    : ''
            ) +
            `topRoll=${LockboxHandler.formatChanceRoll(reward.selectionDebug.topLevelRoll)} ` +
            `topChance=${LockboxHandler.formatPercent(reward.selectionDebug.topLevelChancePercent)} ` +
            `topBand=${LockboxHandler.formatPercent(reward.selectionDebug.topLevelBandStartPercent)}-${LockboxHandler.formatPercent(reward.selectionDebug.topLevelBandEndPercent)} ` +
            (
                reward.selectionDebug.secondaryChancePercent == null
                    ? ''
                    : `subRoll=${LockboxHandler.formatChanceRoll(reward.selectionDebug.secondaryRoll ?? 0)} ` +
                        `subChance=${LockboxHandler.formatPercent(reward.selectionDebug.secondaryChancePercent)} ` +
                        `subPool=${Number(reward.selectionDebug.secondaryPoolSize ?? 0)} `
            ) +
            `sigils=${sigilReward} poolEntries=${rewardPool.rewards.length} poolWeight=${rewardPool.totalWeight} ` +
            `remainingTroves=${LockboxHandler.getLockboxCount(client.character, LockboxHandler.TROVE_LOCKBOX_ID)} ` +
            `remainingKeys=${Number(client.character.DragonKeys ?? 0)}`
        );

        await LockboxHandler.applyReward(client, reward, true);
        await LockboxHandler.saveCharacter(client);
    }

    private static normalizeLockboxes(character: any): Array<{ lockboxID: number; count: number }> {
        const counts = new Map<number, number>();
        for (const entry of Array.isArray(character?.lockboxes) ? character.lockboxes : []) {
            const lockboxId = Number(entry?.lockboxID ?? 0);
            const count = Number(entry?.count ?? 0);
            if (!Number.isFinite(lockboxId) || lockboxId <= 0 || !Number.isFinite(count) || count === 0) {
                continue;
            }
            counts.set(lockboxId, (counts.get(lockboxId) ?? 0) + Math.round(count));
        }

        const normalized = Array.from(counts.entries())
            .filter(([, count]) => count > 0)
            .map(([lockboxID, count]) => ({ lockboxID, count }))
            .sort((left, right) => left.lockboxID - right.lockboxID);

        if (character) {
            character.lockboxes = normalized;
        }

        return normalized;
    }

    private static getLockboxCount(character: any, lockboxId: number): number {
        const entry = LockboxHandler.normalizeLockboxes(character).find((lockbox) => lockbox.lockboxID === lockboxId);
        return Number(entry?.count ?? 0);
    }

    private static addLockboxes(character: any, lockboxId: number, delta: number): number {
        const lockboxes = LockboxHandler.normalizeLockboxes(character);
        const entry = lockboxes.find((lockbox) => lockbox.lockboxID === lockboxId);
        if (entry) {
            entry.count = Math.max(0, Number(entry.count ?? 0) + delta);
        } else if (delta > 0) {
            lockboxes.push({ lockboxID: lockboxId, count: delta });
        }

        const normalized = lockboxes
            .filter((lockbox) => Number(lockbox.count ?? 0) > 0)
            .sort((left, right) => left.lockboxID - right.lockboxID);
        character.lockboxes = normalized;
        return Number(normalized.find((lockbox) => lockbox.lockboxID === lockboxId)?.count ?? 0);
    }

    private static buildRewardPool(character: any): LockboxRewardPoolSnapshot {
        const className = String(character?.class ?? 'paladin').trim().toLowerCase();
        const ownedMounts = new Set<number>(PetHandler.normalizeMountState(character));
        const ownedDyes = new Set<number>(
            (Array.isArray(character?.OwnedDyes) ? character.OwnedDyes : [])
                .map((dyeId: unknown) => Number(dyeId))
                .filter((dyeId: number) => dyeId > 0)
        );
        const ownedGearIds = new Set<number>();
        for (const rawGear of Array.isArray(character?.inventoryGears) ? character.inventoryGears : []) {
            const gearId = Number(rawGear?.gearID ?? 0);
            if (gearId > 0) {
                ownedGearIds.add(gearId);
            }
        }
        for (const rawGear of Array.isArray(character?.equippedGears) ? character.equippedGears : []) {
            const gearId = Number(rawGear?.gearID ?? 0);
            if (gearId > 0) {
                ownedGearIds.add(gearId);
            }
        }

        const availableRewards = LockboxHandler.LOCKBOX_REWARD_POOL.filter((reward) => {
            if (reward.type === 'mount' && reward.name) {
                const mountId = GameData.getMountId(reward.name);
                return mountId <= 0 || !ownedMounts.has(mountId);
            }

            if (reward.type === 'dye') {
                return LockboxHandler.LEGENDARY_DYES.some((dyeName) => !ownedDyes.has(GameData.getDyeId(dyeName)));
            }

            if (reward.type === 'gear') {
                return LockboxHandler.getAvailableClassGearIds(className, ownedGearIds).length > 0;
            }

            return true;
        });

        const rewards = availableRewards.length > 0
            ? availableRewards
            : LockboxHandler.LOCKBOX_REWARD_POOL.filter((reward) =>
                reward.type === 'gold' ||
                reward.type === 'consumable' ||
                reward.type === 'charm' ||
                reward.type === 'egg'
            );
        const totalWeight = rewards.reduce((sum, reward) => sum + Math.max(0, Number(reward.weight ?? 0)), 0);
        return { rewards, totalWeight };
    }

    private static selectReward(
        character: any,
        rewardPoolSnapshot: LockboxRewardPoolSnapshot = LockboxHandler.buildRewardPool(character)
    ): ResolvedLockboxReward {
        const className = String(character?.class ?? 'paladin').trim().toLowerCase();
        const ownedPetTypes = LockboxHandler.getOwnedPetTypeIds(character);
        const ownedDyes = new Set<number>(
            (Array.isArray(character?.OwnedDyes) ? character.OwnedDyes : [])
                .map((dyeId: unknown) => Number(dyeId))
                .filter((dyeId: number) => dyeId > 0)
        );
        const ownedGearIds = new Set<number>();
        for (const rawGear of Array.isArray(character?.inventoryGears) ? character.inventoryGears : []) {
            const gearId = Number(rawGear?.gearID ?? 0);
            if (gearId > 0) {
                ownedGearIds.add(gearId);
            }
        }
        for (const rawGear of Array.isArray(character?.equippedGears) ? character.equippedGears : []) {
            const gearId = Number(rawGear?.gearID ?? 0);
            if (gearId > 0) {
                ownedGearIds.add(gearId);
            }
        }

        const rewardPool = rewardPoolSnapshot.rewards;
        const weightedPick = LockboxHandler.pickWeightedReward(rewardPool);
        const selectedReward = weightedPick?.reward ?? LockboxHandler.LOCKBOX_REWARD_POOL[18];
        const selectionDebug = LockboxHandler.buildSelectionDebug(weightedPick, selectedReward, rewardPoolSnapshot.totalWeight);

        if (selectedReward.type === 'dye') {
            const availableDyeNames = LockboxHandler.LEGENDARY_DYES.filter(
                (dyeName) => !ownedDyes.has(GameData.getDyeId(dyeName))
            );
            const secondaryRoll = Math.random();
            const dyeName = availableDyeNames[Math.floor(secondaryRoll * availableDyeNames.length)] ?? 'BroodMotherBlack';
            const dyeId = GameData.getDyeId(dyeName);
            return {
                index: selectedReward.index,
                type: 'dye',
                grantName: dyeName,
                packetName: dyeName,
                rarity: GameData.DYES.find((dye) => dye.id === dyeId)?.rarity ?? 'L',
                selectionDebug: LockboxHandler.withSecondarySelection(selectionDebug, secondaryRoll, availableDyeNames.length)
            };
        }

        if (selectedReward.type === 'gear') {
            const availableGearIds = LockboxHandler.getAvailableClassGearIds(className, ownedGearIds);
            const secondaryRoll = Math.random();
            const gearId = availableGearIds[Math.floor(secondaryRoll * availableGearIds.length)] ?? 0;
            return {
                index: selectedReward.index,
                type: 'gear',
                grantName: LockboxHandler.CLASS_GEAR_NAMES[gearId] ?? `LockboxGear${gearId}`,
                packetName: LockboxHandler.CLASS_GEAR_NAMES[gearId] ?? `LockboxGear${gearId}`,
                gearId,
                rarity: 'L',
                selectionDebug: LockboxHandler.withSecondarySelection(selectionDebug, secondaryRoll, availableGearIds.length)
            };
        }

        const rewardName = selectedReward.name ?? '';
        if (selectedReward.type === 'egg') {
            const eligiblePets = PetConfig.getHatchablePetsForEggName(rewardName);
            const availablePets = eligiblePets.filter((pet) => {
                const petTypeId = Number(pet?.PetID ?? 0);
                return petTypeId > 0 && !ownedPetTypes.has(petTypeId);
            });
            const secondaryRoll = Math.random();
            if (eligiblePets.length === 0) {
                return {
                    index: selectedReward.index,
                    type: 'gold',
                    grantName: '250,000 Gold',
                    packetName: '250,000 Gold',
                    rarity: 'N/A',
                    goldAmount: 250000,
                    selectionDebug
                };
            }
            if (availablePets.length === 0) {
                return LockboxHandler.buildDuplicatePetFallbackReward(
                    selectedReward,
                    LockboxHandler.withSecondarySelection(selectionDebug, secondaryRoll, 0),
                    'owned_pet_pool_exhausted'
                );
            }

            const petDef = LockboxHandler.resolveRandomPetFromPool(availablePets, secondaryRoll);
            return {
                index: selectedReward.index,
                type: 'egg',
                grantName: String(petDef.PetName ?? rewardName),
                packetName: String(petDef.PetName ?? rewardName),
                rarity: String(petDef.DisplayRarity ?? 'M'),
                selectionDebug: LockboxHandler.withSecondarySelection(selectionDebug, secondaryRoll, availablePets.length)
            };
        }

        if (selectedReward.type === 'pet') {
            const petDef = PetConfig.PET_TYPES.find((pet) => String(pet?.PetName ?? '') === rewardName);
            const petTypeId = Number(petDef?.PetID ?? 0);
            if (petTypeId > 0 && ownedPetTypes.has(petTypeId)) {
                return LockboxHandler.buildDuplicatePetFallbackReward(
                    selectedReward,
                    selectionDebug,
                    'duplicate_pet_type'
                );
            }
        }

        return {
            index: selectedReward.index,
            type: selectedReward.type,
            grantName: rewardName,
            packetName: rewardName,
            rarity: LockboxHandler.resolveRewardRarity(selectedReward.type, rewardName),
            goldAmount: selectedReward.goldAmount,
            selectionDebug
        };
    }

    private static getAvailableClassGearIds(className: string, ownedGearIds: Set<number>): number[] {
        const classGearIds = LockboxHandler.CLASS_GEAR_IDS[className] ?? LockboxHandler.CLASS_GEAR_IDS.paladin;
        return classGearIds.filter((gearId) => !ownedGearIds.has(gearId));
    }

    private static getOwnedPetTypeIds(character: any): Set<number> {
        const ownedPetTypes = new Set<number>();
        for (const pet of PetHandler.normalizePetCollection(character)) {
            const typeId = Number(pet?.typeID ?? 0);
            if (typeId > 0) {
                ownedPetTypes.add(typeId);
            }
        }
        return ownedPetTypes;
    }

    private static resolveRandomPetFromPool(pets: any[], randomValue: number): any {
        const normalizedRandom = Number.isFinite(randomValue) ? Math.max(0, Math.min(randomValue, 0.999999999)) : 0;
        return pets[Math.floor(normalizedRandom * pets.length)] ?? pets[0];
    }

    private static buildDuplicatePetFallbackReward(
        sourceReward: LockboxRewardDefinition,
        selectionDebug: ResolvedLockboxReward['selectionDebug'],
        reason: string
    ): ResolvedLockboxReward {
        const fallbackReward = LockboxHandler.LOCKBOX_REWARD_POOL.find((reward) =>
            reward.type === 'consumable' &&
            reward.name === LockboxHandler.DUPLICATE_PET_FALLBACK_REWARD_NAME
        );
        const fallbackName = fallbackReward?.name ?? LockboxHandler.DUPLICATE_PET_FALLBACK_REWARD_NAME;
        return {
            index: fallbackReward?.index ?? sourceReward.index,
            type: 'consumable',
            grantName: fallbackName,
            packetName: fallbackName,
            rarity: LockboxHandler.resolveRewardRarity('consumable', fallbackName),
            convertedFrom: {
                index: sourceReward.index,
                type: sourceReward.type,
                name: sourceReward.name ?? '',
                reason
            },
            selectionDebug
        };
    }

    private static pickWeightedReward(rewardPool: LockboxRewardDefinition[]): WeightedRewardPick | null {
        const totalWeight = rewardPool.reduce((sum, reward) => sum + Math.max(0, Number(reward.weight ?? 0)), 0);
        if (totalWeight <= 0) {
            return null;
        }

        const roll = Math.random() * totalWeight;
        let remaining = roll;
        let bandStart = 0;
        for (const reward of rewardPool) {
            const weight = Math.max(0, Number(reward.weight ?? 0));
            remaining -= weight;
            if (remaining < 0) {
                return {
                    reward,
                    roll,
                    bandStart,
                    bandEnd: bandStart + weight,
                    totalWeight
                };
            }
            bandStart += weight;
        }

        const reward = rewardPool[rewardPool.length - 1];
        if (!reward) {
            return null;
        }
        const weight = Math.max(0, Number(reward.weight ?? 0));
        return {
            reward,
            roll,
            bandStart: Math.max(0, totalWeight - weight),
            bandEnd: totalWeight,
            totalWeight
        };
    }

    private static buildSelectionDebug(
        weightedPick: WeightedRewardPick | null,
        selectedReward: LockboxRewardDefinition,
        totalWeight: number
    ): ResolvedLockboxReward['selectionDebug'] {
        const safeTotalWeight = Math.max(0, Number(weightedPick?.totalWeight ?? totalWeight ?? 0));
        const selectedWeight = Math.max(0, Number(selectedReward.weight ?? 0));
        return {
            topLevelRoll: safeTotalWeight > 0 ? Number(weightedPick?.roll ?? 0) / safeTotalWeight : 0,
            topLevelChancePercent: safeTotalWeight > 0 ? (selectedWeight / safeTotalWeight) * 100 : 0,
            topLevelBandStartPercent: safeTotalWeight > 0 ? (Number(weightedPick?.bandStart ?? 0) / safeTotalWeight) * 100 : 0,
            topLevelBandEndPercent: safeTotalWeight > 0 ? (Number(weightedPick?.bandEnd ?? selectedWeight) / safeTotalWeight) * 100 : 0
        };
    }

    private static withSecondarySelection(
        selectionDebug: ResolvedLockboxReward['selectionDebug'],
        secondaryRoll: number,
        poolSize: number
    ): ResolvedLockboxReward['selectionDebug'] {
        return {
            ...selectionDebug,
            secondaryRoll,
            secondaryChancePercent: poolSize > 0 ? 100 / poolSize : 0,
            secondaryPoolSize: poolSize
        };
    }

    private static resolveRewardRarity(type: LockboxRewardType, rewardName: string): string {
        if (type === 'mount') {
            return 'L';
        }

        if (type === 'pet') {
            return String(
                PetConfig.PET_TYPES.find((pet) => String(pet?.PetName ?? '') === rewardName)?.DisplayRarity ?? 'L'
            );
        }

        if (type === 'consumable') {
            return String(
                GameData.CONSUMABLES.find((consumable) => String(consumable?.ConsumableName ?? '') === rewardName)?.Rarity ?? 'N/A'
            );
        }

        if (type === 'gold') {
            return 'N/A';
        }

        if (type === 'charm') {
            return 'Special';
        }

        return 'N/A';
    }

    private static formatPercent(value: number): string {
        return `${Number(value ?? 0).toFixed(3)}%`;
    }

    private static formatChanceRoll(value: number): string {
        return LockboxHandler.formatPercent(Math.max(0, Math.min(1, Number(value ?? 0))) * 100);
    }

    private static async applyReward(client: Client, reward: ResolvedLockboxReward, walletAlreadyUpdated: boolean = false): Promise<void> {
        const character = client.character;
        if (!character) {
            return;
        }

        if (reward.type === 'gold') {
            const goldAmount = Number(reward.goldAmount ?? 0);
            if (goldAmount > 0) {
                if (!walletAlreadyUpdated) {
                    await WalletService.grant(client, 'gold', goldAmount);
                }
                RewardHandler.sendGoldReward(client, goldAmount, false);
            }
            return;
        }

        if (reward.type === 'consumable') {
            const consumableId = GameData.getConsumableId(reward.grantName);
            if (consumableId <= 0) {
                return;
            }

            const consumables = Array.isArray(character.consumables) ? character.consumables : [];
            const entry = consumables.find((consumable: any) => Number(consumable?.consumableID ?? 0) === consumableId);
            if (entry) {
                entry.count = Number(entry.count ?? 0) + 1;
            } else {
                consumables.push({ consumableID: consumableId, count: 1 });
            }
            character.consumables = consumables;
            LockboxHandler.sendConsumableReward(client, consumableId, 1, Number(entry?.count ?? 1));
            return;
        }

        if (reward.type === 'charm') {
            const charmId = GameData.getCharmId(reward.grantName);
            if (charmId <= 0) {
                return;
            }

            const charms = Array.isArray(character.charms) ? character.charms : [];
            const entry = charms.find((charm: any) => Number(charm?.charmID ?? 0) === charmId);
            if (entry) {
                entry.count = Number(entry.count ?? 0) + 1;
            } else {
                charms.push({ charmID: charmId, count: 1 });
            }
            character.charms = charms;
            LockboxHandler.sendCharmReward(client, charmId);
            return;
        }

        if (reward.type === 'mount') {
            const mountId = GameData.getMountId(reward.grantName);
            if (mountId <= 0) {
                return;
            }

            const mounts = PetHandler.normalizeMountState(character);
            if (!mounts.includes(mountId)) {
                mounts.push(mountId);
            }
            character.mounts = Array.from(new Set(mounts)).sort((left, right) => left - right);
            LockboxHandler.sendMountReward(client, mountId, false);
            return;
        }

        if (reward.type === 'pet' || reward.type === 'egg') {
            const petDef = PetConfig.PET_TYPES.find((pet) => String(pet.PetName) === reward.grantName);
            if (!petDef) {
                return;
            }

            const pets = Array.isArray(character.pets) ? character.pets : [];
            const nextSpecialId = pets.reduce((max: number, pet: any) =>
                Math.max(max, Number(pet?.special_id ?? 0)), 0) + 1;
            const petLevel = reward.type === 'egg' ? 10 : 1;
            pets.push({
                typeID: Number(petDef.PetID ?? 0),
                special_id: nextSpecialId,
                level: petLevel,
                xp: 0
            });
            character.pets = pets;
            LockboxHandler.sendNewPetReward(client, Number(petDef.PetID ?? 0), nextSpecialId, petLevel, false);
            return;
        }

        if (reward.type === 'dye') {
            const dyeId = GameData.getDyeId(reward.grantName);
            if (dyeId <= 0) {
                return;
            }

            const ownedDyes = new Set<number>(
                (Array.isArray(character.OwnedDyes) ? character.OwnedDyes : [])
                    .map((dye: unknown) => Number(dye))
                    .filter((dyeIdValue: number) => dyeIdValue > 0)
            );
            ownedDyes.add(dyeId);
            character.OwnedDyes = Array.from(ownedDyes.values()).sort((left, right) => left - right);
            LockboxHandler.sendDyeReward(client, dyeId, false);
            return;
        }

        if (reward.type === 'gear') {
            const gearId = Number(reward.gearId ?? 0);
            if (gearId <= 0) {
                return;
            }

            upsertInventoryGear(character, gearId, 2, [0, 0, 0], [0, 0]);
            LockboxHandler.sendGearReward(client, gearId, 2);
        }
    }

    private static sendGoldLoss(client: Client, amount: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(amount);
        client.sendBitBuffer(0xB4, bb);
    }

    private static sendIdolLoss(client: Client, purchaseName: string, amount: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod13(purchaseName);
        bb.writeMethod4(amount);
        client.sendBitBuffer(0xB5, bb);
    }

    private static sendLockboxInventoryDelta(client: Client, lockboxId: number, delta: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(lockboxId, 2);
        bb.writeMethod4(delta);
        bb.writeMethod15(true);
        client.sendBitBuffer(0x104, bb);
    }

    private static sendLockboxReveal(client: Client, reward: ResolvedLockboxReward): void {
        const bb = new BitBuffer(false);
        if (reward.type === 'dye') {
            bb.writeMethod6(4, 3);
            bb.writeMethod6(0, 6);
        } else {
            bb.writeMethod6(1, 3);
            bb.writeMethod6(reward.index, 6);
        }
        bb.writeMethod6(1, 1);
        bb.writeMethod13(reward.packetName);
        client.sendBitBuffer(0x108, bb);
    }

    private static sendRoyalSigilReward(client: Client, amount: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(amount);
        client.sendBitBuffer(0x112, bb);
    }

    private static sendMountReward(client: Client, mountId: number, suppress: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(mountId);
        bb.writeMethod15(suppress);
        client.sendBitBuffer(0x36, bb);
    }

    private static sendNewPetReward(
        client: Client,
        petTypeId: number,
        specialId: number,
        level: number,
        suppress: boolean
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(petTypeId, 7);
        bb.writeMethod4(specialId);
        bb.writeMethod6(level, 6);
        bb.writeMethod15(suppress);
        client.sendBitBuffer(0x37, bb);
    }

    private static sendConsumableReward(client: Client, consumableId: number, amount: number, newTotal: number): void {
        const update = new BitBuffer(false);
        update.writeMethod6(consumableId, 5);
        update.writeMethod4(newTotal);
        client.sendBitBuffer(0x10C, update);

        const consumableDef = GameData.CONSUMABLES.find((consumable) => Number(consumable?.ConsumableID ?? 0) === consumableId);
        const displayAmount = String(consumableDef?.Type ?? '') === 'Potion' ? amount * 5000 : amount;

        const reward = new BitBuffer(false);
        reward.writeMethod6(consumableId, 5);
        reward.writeMethod4(displayAmount);
        reward.writeMethod15(false);
        client.sendBitBuffer(0x10B, reward);
    }

    private static sendCharmReward(client: Client, charmId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(charmId, 16);
        bb.writeMethod15(false);
        client.sendBitBuffer(0x109, bb);
    }

    private static sendDyeReward(client: Client, dyeId: number, suppress: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(dyeId, 8);
        bb.writeMethod15(suppress);
        client.sendBitBuffer(0x10A, bb);
    }

    private static sendGearReward(client: Client, gearId: number, tier: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(gearId, 11);
        bb.writeMethod6(tier, 2);
        client.sendBitBuffer(0x33, bb);
    }

    private static async saveCharacter(client: Client): Promise<void> {
        if (!client.character) {
            return;
        }

        if (!client.userId) {
            const normalizedName = String(client.character.name ?? '').trim().toLowerCase();
            const existingIndex = client.characters.findIndex((character) =>
                String(character?.name ?? '').trim().toLowerCase() === normalizedName
            );
            if (existingIndex >= 0) {
                client.characters[existingIndex] = client.character;
            } else {
                client.characters.push(client.character);
            }
            return;
        }

        client.characters = await db.saveCharacterSnapshot(client.userId, client.character);
    }
}
