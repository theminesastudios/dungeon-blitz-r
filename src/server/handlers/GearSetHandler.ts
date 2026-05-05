import { Client } from '../core/Client';
import { JsonAdapter } from '../database/JsonAdapter';
import { BitReader } from '../network/protocol/bitReader';

const db = new JsonAdapter();

type GearSetEntry = {
    name: string;
    slots: number[];
};

export class GearSetHandler {
    private static readonly MAX_GEAR_SETS = 7;
    private static readonly GEAR_SET_INDEX_BITS = 3;
    private static readonly EQUIPMENT_SLOT_COUNT = 6;
    private static readonly MAX_NAME_LENGTH = 16;

    static async handleOverwriteGearSet(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const index = GearSetHandler.readGearSetIndex(data);
        if (index === null) {
            return;
        }

        const gearSets = GearSetHandler.ensureGearSets(client.character);
        if (index < 0 || index >= gearSets.length) {
            return;
        }

        const existing = gearSets[index];
        gearSets[index] = {
            name: existing.name,
            slots: GearSetHandler.snapshotEquippedSlots(client.character)
        };

        await GearSetHandler.persistCharacter(client);
    }

    static async handleCreateGearSet(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const index = GearSetHandler.readGearSetIndex(data);
        if (index === null) {
            return;
        }

        const gearSets = GearSetHandler.ensureGearSets(client.character);
        if (
            index < 0 ||
            index >= GearSetHandler.MAX_GEAR_SETS ||
            gearSets.length >= GearSetHandler.MAX_GEAR_SETS ||
            index < gearSets.length
        ) {
            return;
        }

        gearSets.push({
            name: GearSetHandler.defaultGearSetName(index),
            slots: GearSetHandler.emptySlots()
        });

        await GearSetHandler.persistCharacter(client);
    }

    static async handleRenameGearSet(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        let index: number;
        let name: string;
        try {
            index = br.readMethod20(GearSetHandler.GEAR_SET_INDEX_BITS);
            name = br.readMethod26();
        } catch {
            return;
        }

        const gearSets = GearSetHandler.ensureGearSets(client.character);
        if (index < 0 || index >= gearSets.length) {
            return;
        }

        gearSets[index] = {
            ...gearSets[index],
            name: GearSetHandler.normalizeName(name, index)
        };

        await GearSetHandler.persistCharacter(client);
    }

    private static readGearSetIndex(data: Buffer): number | null {
        try {
            return new BitReader(data).readMethod20(GearSetHandler.GEAR_SET_INDEX_BITS);
        } catch {
            return null;
        }
    }

    private static ensureGearSets(character: Record<string, any>): GearSetEntry[] {
        const rawGearSets = Array.isArray(character.gearSets) ? character.gearSets : [];
        const normalized = rawGearSets
            .slice(0, GearSetHandler.MAX_GEAR_SETS)
            .map((rawEntry: unknown, index: number) => GearSetHandler.normalizeGearSet(rawEntry, index));

        character.gearSets = normalized;
        return normalized;
    }

    private static normalizeGearSet(rawEntry: unknown, index: number): GearSetEntry {
        const entry = rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry)
            ? rawEntry as Record<string, any>
            : {};
        const rawSlots = Array.isArray(entry.slots) ? entry.slots : [];
        const slots = Array.from({ length: GearSetHandler.EQUIPMENT_SLOT_COUNT + 1 }, (_, slotIndex) =>
            slotIndex === 0 ? 0 : Math.max(0, Number(rawSlots[slotIndex] ?? 0) || 0)
        );

        return {
            name: GearSetHandler.normalizeName(String(entry.name ?? ''), index),
            slots
        };
    }

    private static snapshotEquippedSlots(character: Record<string, any>): number[] {
        const equippedGears = Array.isArray(character.equippedGears) ? character.equippedGears : [];
        return Array.from({ length: GearSetHandler.EQUIPMENT_SLOT_COUNT + 1 }, (_, slotIndex) => {
            if (slotIndex === 0) {
                return 0;
            }

            const gear = equippedGears[slotIndex - 1];
            return Math.max(0, Number(gear?.gearID ?? 0) || 0);
        });
    }

    private static emptySlots(): number[] {
        return Array.from({ length: GearSetHandler.EQUIPMENT_SLOT_COUNT + 1 }, () => 0);
    }

    private static normalizeName(name: string, index: number): string {
        const normalized = String(name ?? '').replace(/\0/g, '').trim().slice(0, GearSetHandler.MAX_NAME_LENGTH);
        return normalized || GearSetHandler.defaultGearSetName(index);
    }

    private static defaultGearSetName(index: number): string {
        return `GearSet ${index + 1}`;
    }

    private static upsertCharacterSnapshot(client: Client): void {
        if (!client.character) {
            return;
        }

        const normalizedName = String(client.character.name ?? '').trim().toLowerCase();
        const index = client.characters.findIndex((entry) =>
            String(entry?.name ?? '').trim().toLowerCase() === normalizedName
        );

        if (index >= 0) {
            client.characters[index] = client.character;
            return;
        }

        client.characters.push(client.character);
    }

    private static async persistCharacter(client: Client): Promise<void> {
        GearSetHandler.upsertCharacterSnapshot(client);
        if (client.userId) {
            client.characters = await db.saveCharacterSnapshot(client.userId, client.character!);
        }
    }
}
