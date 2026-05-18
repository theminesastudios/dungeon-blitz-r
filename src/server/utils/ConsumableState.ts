import { Client } from '../core/Client';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { BitBuffer } from '../network/protocol/bitBuffer';

const POTION_CHARGE_UNITS = 5000;

export type ActivePotionBonuses = {
    goldFind: number;
    itemFind: number;
    craftFind: number;
    expBonus: number;
};

const ZERO_POTION_BONUSES: ActivePotionBonuses = {
    goldFind: 0,
    itemFind: 0,
    craftFind: 0,
    expBonus: 0
};

function normalizePotionCharges(value: unknown): number {
    const numeric = Math.max(0, Math.round(Number(value ?? 0)));
    if (numeric <= 0) {
        return 0;
    }
    return Math.min(POTION_CHARGE_UNITS, numeric);
}

export function getConsumableDef(consumableId: number): any | null {
    if (!Number.isFinite(consumableId) || consumableId <= 0) {
        return null;
    }

    return GameData.CONSUMABLES.find(
        (entry) => Number(entry?.ConsumableID ?? 0) === Math.round(consumableId)
    ) ?? null;
}

export function isPotionConsumable(consumableId: number): boolean {
    return String(getConsumableDef(consumableId)?.Type ?? '') === 'Potion';
}

export function getStoredConsumableEntry(character: any, consumableId: number): any | null {
    if (!character || consumableId <= 0) {
        return null;
    }

    const consumables = Array.isArray(character.consumables) ? character.consumables : [];
    return consumables.find(
        (entry: any) => Number(entry?.consumableID ?? 0) === Math.round(consumableId)
    ) ?? null;
}

export function compactConsumableInventory(character: any): boolean {
    if (!character) {
        return false;
    }

    const consumables = Array.isArray(character.consumables) ? character.consumables : [];
    const filtered = consumables.filter((entry: any) => Math.max(0, Number(entry?.count ?? 0)) > 0);
    if (filtered.length === consumables.length) {
        return false;
    }

    character.consumables = filtered;
    return true;
}

export function getStoredConsumableCount(character: any, consumableId: number): number {
    return Math.max(0, Number(getStoredConsumableEntry(character, consumableId)?.count ?? 0));
}

export function getActivePotionCharges(character: any): number {
    return normalizePotionCharges(character?.activeConsumableCharges);
}

export function getVisibleConsumableCount(character: any, consumableId: number): number {
    const storedCount = getStoredConsumableCount(character, consumableId);
    if (!isPotionConsumable(consumableId)) {
        return storedCount;
    }

    const activeConsumableId = Math.max(0, Math.round(Number(character?.activeConsumableID ?? 0)));
    const activeCharges = getActivePotionCharges(character);
    if (activeConsumableId !== consumableId || activeCharges <= 0) {
        return storedCount;
    }

    return storedCount * POTION_CHARGE_UNITS + activeCharges;
}

export function sendConsumableUpdate(client: Client, consumableId: number): void {
    const bb = new BitBuffer(false);
    bb.writeMethod6(Math.max(0, Math.round(Number(consumableId ?? 0))), 5);
    bb.writeMethod4(getVisibleConsumableCount(client.character, consumableId));
    client.sendBitBuffer(0x10C, bb);
}

export function hasAvailablePotionSelection(character: any, consumableId: number): boolean {
    if (!character || consumableId <= 0) {
        return false;
    }

    if (!isPotionConsumable(consumableId) && String(getConsumableDef(consumableId)?.Type ?? '') !== 'ResPotion') {
        return false;
    }

    if (getStoredConsumableCount(character, consumableId) > 0) {
        return true;
    }

    return Number(character?.activeConsumableID ?? 0) === consumableId && getActivePotionCharges(character) > 0;
}

export function ensureActiveDungeonPotionReserved(character: any, currentLevel: string | null | undefined, consumableId?: number): boolean {
    if (!character || !LevelConfig.isDungeonLevel(currentLevel)) {
        return false;
    }

    const targetConsumableId = Math.max(0, Math.round(Number(consumableId ?? character.activeConsumableID ?? 0)));
    if (!isPotionConsumable(targetConsumableId)) {
        return false;
    }

    if (
        Number(character.activeConsumableID ?? 0) === targetConsumableId &&
        getActivePotionCharges(character) > 0
    ) {
        return false;
    }

    const entry = getStoredConsumableEntry(character, targetConsumableId);
    const currentCount = Math.max(0, Number(entry?.count ?? 0));
    if (!entry || currentCount <= 0) {
        return false;
    }

    entry.count = currentCount - 1;
    character.activeConsumableCharges = POTION_CHARGE_UNITS;
    return true;
}

export function clearActivePotionReservation(character: any): boolean {
    if (!character) {
        return false;
    }

    const activeConsumableId = Math.max(0, Math.round(Number(character.activeConsumableID ?? 0)));
    const activeCharges = getActivePotionCharges(character);
    if (!isPotionConsumable(activeConsumableId) && activeCharges <= 0) {
        return false;
    }

    const didChange = isPotionConsumable(activeConsumableId) || activeCharges > 0;
    character.activeConsumableCharges = 0;
    if (isPotionConsumable(activeConsumableId)) {
        character.activeConsumableID = 0;
    }
    return didChange;
}

export function syncPotionReservationForLevelTransition(
    character: any,
    oldLevel: string | null | undefined,
    targetLevel: string | null | undefined
): boolean {
    if (!character) {
        return false;
    }

    const normalizedOldLevel = LevelConfig.normalizeLevelName(oldLevel);
    const normalizedTargetLevel = LevelConfig.normalizeLevelName(targetLevel);
    if (!normalizedTargetLevel) {
        return false;
    }

    let didChange = false;
    if (
        normalizedOldLevel &&
        normalizedOldLevel !== normalizedTargetLevel &&
        LevelConfig.isDungeonLevel(normalizedOldLevel)
    ) {
        didChange = clearActivePotionReservation(character) || didChange;
    }

    if (
        normalizedOldLevel !== normalizedTargetLevel &&
        ensureActiveDungeonPotionReserved(character, normalizedTargetLevel)
    ) {
        didChange = true;
    }

    return didChange;
}

export function reconcileConsumableSelectionState(character: any): boolean {
    if (!character) {
        return false;
    }

    let didChange = false;
    const activeConsumableId = Math.max(0, Math.round(Number(character.activeConsumableID ?? 0)));
    if (activeConsumableId > 0 && !hasAvailablePotionSelection(character, activeConsumableId)) {
        character.activeConsumableID = 0;
        character.activeConsumableCharges = 0;
        didChange = true;
    }

    const queuedConsumableId = Math.max(0, Math.round(Number(character.queuedConsumableID ?? 0)));
    if (queuedConsumableId > 0 && !hasAvailablePotionSelection(character, queuedConsumableId)) {
        character.queuedConsumableID = 0;
        didChange = true;
    }

    if (Math.max(0, Math.round(Number(character.activeConsumableID ?? 0))) === 0 && getActivePotionCharges(character) <= 0) {
        const currentCharges = Math.max(0, Math.round(Number(character.activeConsumableCharges ?? 0)));
        if (currentCharges !== 0) {
            character.activeConsumableCharges = 0;
            didChange = true;
        }
    }

    didChange = compactConsumableInventory(character) || didChange;
    return didChange;
}

export function getActivePotionBonuses(character: any, currentLevel: string | null | undefined): ActivePotionBonuses {
    if (!character || !LevelConfig.isDungeonLevel(currentLevel)) {
        return ZERO_POTION_BONUSES;
    }

    const activeConsumableId = Math.max(0, Math.round(Number(character.activeConsumableID ?? 0)));
    if (!isPotionConsumable(activeConsumableId) || getActivePotionCharges(character) <= 0) {
        return ZERO_POTION_BONUSES;
    }

    const consumable = getConsumableDef(activeConsumableId);
    if (!consumable) {
        return ZERO_POTION_BONUSES;
    }

    return {
        goldFind: Math.max(0, Number(consumable.GoldFind ?? 0)),
        itemFind: Math.max(0, Number(consumable.GearFind ?? 0)),
        craftFind: Math.max(0, Number(consumable.MaterialFind ?? 0)),
        expBonus: Math.max(0, Number(consumable.XP ?? 0))
    };
}
