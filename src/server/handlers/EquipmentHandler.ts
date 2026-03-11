import { Client } from '../core/Client';
import { GlobalState } from '../core/GlobalState';
import { JsonAdapter } from '../database/JsonAdapter';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

const db = new JsonAdapter();

type GearEntry = Record<string, any>;

export class EquipmentHandler {
    private static readonly FIRST_SLOT = 1;
    private static readonly LAST_SLOT = 6;
    private static readonly SLOT_TO_GEAR_INDEX: Record<number, number> = {
        1: 0, // Armor
        2: 1, // Gloves
        3: 2, // Boots
        4: 3, // Hat
        5: 4, // Weapon
        6: 5  // Off-hand
    };

    static async handleUpdateEquipment(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const entityId = br.readMethod9();
        if (!EquipmentHandler.isOwnEntity(client, entityId)) {
            return;
        }

        const changedSlots = new Set<number>();
        for (let slot = EquipmentHandler.FIRST_SLOT; slot <= EquipmentHandler.LAST_SLOT; slot++) {
            if (!br.readMethod15()) {
                continue;
            }

            const gearId = br.readMethod6(11);
            EquipmentHandler.applyGearToSlot(client, slot, gearId);
            changedSlots.add(slot);
        }

        await EquipmentHandler.persistAndBroadcast(client, entityId, changedSlots);
    }

    static async handleUpdateSingleGear(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const entityId = br.readMethod9();
        if (!EquipmentHandler.isOwnEntity(client, entityId)) {
            return;
        }

        const slot = br.readMethod236();
        const gearId = br.readMethod20(11);
        EquipmentHandler.applyGearToSlot(client, slot, gearId);

        await EquipmentHandler.persistAndBroadcast(client, entityId, new Set([slot]));
    }

    private static isOwnEntity(client: Client, entityId: number): boolean {
        return entityId > 0 && (!client.clientEntID || entityId === client.clientEntID);
    }

    private static getGearArrayIndex(slot: number): number {
        return EquipmentHandler.SLOT_TO_GEAR_INDEX[slot] ?? -1;
    }

    private static emptyGearEntry(): GearEntry {
        return {
            gearID: 0,
            tier: 0,
            runes: [0, 0, 0],
            colors: [0, 0]
        };
    }

    private static normalizeGearEntry(value: unknown): GearEntry {
        const raw = value && typeof value === 'object' && !Array.isArray(value)
            ? value as GearEntry
            : {};

        return {
            gearID: Number(raw.gearID ?? 0),
            tier: Number(raw.tier ?? 0),
            runes: Array.isArray(raw.runes) ? raw.runes.map((entry) => Number(entry ?? 0)).slice(0, 3) : [0, 0, 0],
            colors: Array.isArray(raw.colors) ? raw.colors.map((entry) => Number(entry ?? 0)).slice(0, 2) : [0, 0]
        };
    }

    private static ensureEquippedGears(client: Client): GearEntry[] {
        const current = Array.isArray(client.character?.equippedGears) ? client.character!.equippedGears : [];
        const next = Array.from({ length: EquipmentHandler.LAST_SLOT }, (_, index) =>
            EquipmentHandler.normalizeGearEntry(current[index] ?? EquipmentHandler.emptyGearEntry())
        );

        client.character!.equippedGears = next;
        return next;
    }

    private static resolveOwnedGear(client: Client, gearId: number): GearEntry | null {
        const candidates: GearEntry[] = [];
        const sources = [
            Array.isArray(client.character?.inventoryGears) ? client.character!.inventoryGears : [],
            Array.isArray(client.character?.equippedGears) ? client.character!.equippedGears : []
        ];

        for (const source of sources) {
            for (const rawEntry of source) {
                const entry = EquipmentHandler.normalizeGearEntry(rawEntry);
                if (Number(entry.gearID) === gearId) {
                    candidates.push(entry);
                }
            }
        }

        if (!candidates.length) {
            return null;
        }

        candidates.sort((left, right) => Number(right.tier ?? 0) - Number(left.tier ?? 0));
        return candidates[0];
    }

    private static applyGearToSlot(client: Client, slot: number, gearId: number): void {
        const index = EquipmentHandler.getGearArrayIndex(slot);
        if (index < 0 || !client.character) {
            return;
        }

        const equippedGears = EquipmentHandler.ensureEquippedGears(client);
        const nextGear = gearId > 0
            ? EquipmentHandler.normalizeGearEntry(
                EquipmentHandler.resolveOwnedGear(client, gearId) ?? {
                    gearID: gearId,
                    tier: 0,
                    runes: [0, 0, 0],
                    colors: [0, 0]
                }
            )
            : EquipmentHandler.emptyGearEntry();

        equippedGears[index] = nextGear;
        EquipmentHandler.updateLiveEntity(client);
    }

    private static updateLiveEntity(client: Client): void {
        if (!client.character || client.clientEntID <= 0) {
            return;
        }

        const localEntity = client.entities.get(client.clientEntID);
        if (localEntity && typeof localEntity === 'object') {
            localEntity.equippedGears = client.character.equippedGears;
        }

        if (!client.currentLevel) {
            return;
        }

        const levelMap = GlobalState.levelEntities.get(client.currentLevel);
        const levelEntity = levelMap?.get(client.clientEntID);
        if (levelEntity && typeof levelEntity === 'object') {
            levelEntity.equippedGears = client.character.equippedGears;
        }
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

    private static buildEquipmentUpdatePacket(entityId: number, changedSlots: Set<number>, equippedGears: GearEntry[]): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);

        for (let slot = EquipmentHandler.FIRST_SLOT; slot <= EquipmentHandler.LAST_SLOT; slot++) {
            const index = EquipmentHandler.getGearArrayIndex(slot);
            const gear = EquipmentHandler.normalizeGearEntry(equippedGears[index] ?? EquipmentHandler.emptyGearEntry());
            const changed = changedSlots.has(slot);

            bb.writeMethod15(changed);
            if (!changed) {
                continue;
            }

            const gearId = Number(gear.gearID ?? 0);
            bb.writeMethod15(gearId > 0);
            if (!gearId) {
                continue;
            }

            const runes = Array.isArray(gear.runes) ? gear.runes : [0, 0, 0];
            const colors = Array.isArray(gear.colors) ? gear.colors : [0, 0];
            bb.writeMethod6(gearId, 11);
            bb.writeMethod6(Number(gear.tier ?? 0), 2);
            bb.writeMethod6(Number(runes[0] ?? 0), 16);
            bb.writeMethod6(Number(runes[1] ?? 0), 16);
            bb.writeMethod6(Number(runes[2] ?? 0), 16);
            bb.writeMethod6(Number(colors[0] ?? 0), 8);
            bb.writeMethod6(Number(colors[1] ?? 0), 8);
        }

        return bb.toBuffer();
    }

    private static broadcastEquipmentUpdate(client: Client, entityId: number, changedSlots: Set<number>): void {
        if (!client.currentLevel || !client.playerSpawned || !client.character || changedSlots.size === 0) {
            return;
        }

        const payload = EquipmentHandler.buildEquipmentUpdatePacket(
            entityId,
            changedSlots,
            EquipmentHandler.ensureEquippedGears(client)
        );

        for (const other of GlobalState.sessionsByToken.values()) {
            if (other === client || !other.playerSpawned || other.currentLevel !== client.currentLevel) {
                continue;
            }

            other.send(0x30, payload);
        }
    }

    private static async persistAndBroadcast(client: Client, entityId: number, changedSlots: Set<number>): Promise<void> {
        if (!client.character || changedSlots.size === 0) {
            return;
        }

        EquipmentHandler.upsertCharacterSnapshot(client);
        if (client.userId) {
            await db.saveCharacters(client.userId, client.characters);
        }

        EquipmentHandler.broadcastEquipmentUpdate(client, entityId, changedSlots);
    }
}
