import { MAX_GEAR_TIER } from '../core/GameData';

type GearEntry = {
    gearID: number;
    tier: number;
    runes: number[];
    colors: number[];
};

function normalizeTier(value: unknown): number {
    const tier = Number(value ?? 0);
    if (!Number.isFinite(tier) || tier <= 0) {
        return 0;
    }
    // Tier travels in 2 bits: 0 Magic, 1 Rare, 2 Legendary, 3 Mystic. This used to clamp at 2,
    // which silently demoted Mystic gear back to Legendary in every packet built from a
    // normalized inventory.
    return Math.min(MAX_GEAR_TIER, Math.round(tier));
}

function normalizeGearId(value: unknown): number {
    const gearId = Number(value ?? 0);
    return Number.isFinite(gearId) && gearId > 0 ? gearId : 0;
}

export function normalizeGearEntry(raw: unknown): GearEntry {
    const entry = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};

    return {
        gearID: normalizeGearId(entry.gearID),
        tier: normalizeTier(entry.tier),
        runes: Array.isArray(entry.runes) ? entry.runes.map((value) => Number(value ?? 0)).slice(0, 3) : [0, 0, 0],
        colors: Array.isArray(entry.colors) ? entry.colors.map((value) => Number(value ?? 0)).slice(0, 2) : [0, 0]
    };
}

function gearModifierScore(entry: GearEntry): number {
    const runeScore = entry.runes.reduce((total, value) => total + (Number(value) !== 0 ? 1 : 0), 0);
    const colorScore = entry.colors.reduce((total, value) => total + (Number(value) !== 0 ? 1 : 0), 0);
    return runeScore + colorScore;
}

export function dedupeInventoryGears(rawInventory: unknown): GearEntry[] {
    const inventory = Array.isArray(rawInventory) ? rawInventory : [];
    const orderedKeys: string[] = [];
    const deduped = new Map<string, GearEntry>();

    for (const rawEntry of inventory) {
        const entry = normalizeGearEntry(rawEntry);
        if (entry.gearID <= 0) {
            continue;
        }

        const key = `${entry.gearID}:${entry.tier}`;
        const existing = deduped.get(key);
        if (!existing) {
            orderedKeys.push(key);
            deduped.set(key, entry);
            continue;
        }

        if (gearModifierScore(entry) > gearModifierScore(existing)) {
            deduped.set(key, entry);
        }
    }

    const result = orderedKeys
        .map((key) => deduped.get(key))
        .filter((entry): entry is GearEntry => Boolean(entry));

    return collapseToHighestTier(result);
}

function collapseToHighestTier(entries: GearEntry[]): GearEntry[] {
    const bestByGearId = new Map<number, GearEntry>();
    const insertionOrder: number[] = [];

    for (const entry of entries) {
        const existing = bestByGearId.get(entry.gearID);
        if (!existing) {
            insertionOrder.push(entry.gearID);
            bestByGearId.set(entry.gearID, entry);
            continue;
        }

        if (entry.tier > existing.tier) {
            if (gearModifierScore(entry) === 0 && gearModifierScore(existing) > 0) {
                entry.runes = [...existing.runes];
                entry.colors = [...existing.colors];
            }
            bestByGearId.set(entry.gearID, entry);
        } else if (entry.tier === existing.tier) {
            if (gearModifierScore(entry) > gearModifierScore(existing)) {
                bestByGearId.set(entry.gearID, entry);
            }
        } else {
            if (gearModifierScore(existing) === 0 && gearModifierScore(entry) > 0) {
                existing.runes = [...entry.runes];
                existing.colors = [...entry.colors];
            }
        }
    }

    return insertionOrder
        .map((gearId) => bestByGearId.get(gearId))
        .filter((entry): entry is GearEntry => Boolean(entry));
}

export function normalizeCharacterInventoryGears(character: any): GearEntry[] {
    const normalized = dedupeInventoryGears(character?.inventoryGears);
    if (character) {
        character.inventoryGears = normalized;
    }
    return normalized;
}

export function upsertInventoryGear(
    character: any,
    gearId: unknown,
    tier: unknown,
    runes: unknown[] = [0, 0, 0],
    colors: unknown[] = [0, 0]
): { inserted: boolean; inventory: GearEntry[] } {
    const inventory = normalizeCharacterInventoryGears(character);
    const normalizedGearId = normalizeGearId(gearId);
    const normalizedTier = normalizeTier(tier);
    if (normalizedGearId <= 0) {
        return { inserted: false, inventory };
    }

    const existingIndex = inventory.findIndex((entry) => entry.gearID === normalizedGearId);
    if (existingIndex >= 0) {
        const existing = inventory[existingIndex];
        if (existing.tier >= normalizedTier) {
            return { inserted: false, inventory };
        }
        const newEntry: GearEntry = {
            gearID: normalizedGearId,
            tier: normalizedTier,
            runes: Array.isArray(runes) ? runes.map((value) => Number(value ?? 0)).slice(0, 3) : [0, 0, 0],
            colors: Array.isArray(colors) ? colors.map((value) => Number(value ?? 0)).slice(0, 2) : [0, 0]
        };
        if (gearModifierScore(newEntry) === 0 && gearModifierScore(existing) > 0) {
            newEntry.runes = [...existing.runes];
            newEntry.colors = [...existing.colors];
        }
        inventory[existingIndex] = newEntry;
    } else {
        inventory.push({
            gearID: normalizedGearId,
            tier: normalizedTier,
            runes: Array.isArray(runes) ? runes.map((value) => Number(value ?? 0)).slice(0, 3) : [0, 0, 0],
            colors: Array.isArray(colors) ? colors.map((value) => Number(value ?? 0)).slice(0, 2) : [0, 0]
        });
    }

    if (character) {
        character.inventoryGears = inventory;
    }

    return { inserted: true, inventory };
}
