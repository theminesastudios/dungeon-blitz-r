import { Client } from '../core/Client';
import { GlobalState } from '../core/GlobalState';
import { JsonAdapter } from '../database/JsonAdapter';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { CharacterSync } from '../utils/CharacterSync';
import { EntityHandler } from './EntityHandler';
import { areClientsInSameLevelScope, getClientLevelScope } from '../core/LevelScope';
import { CharmID } from '../data/runtime/Charms';

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

        EquipmentHandler.persistAndBroadcast(client, entityId, changedSlots);
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

        EquipmentHandler.persistAndBroadcast(client, entityId, new Set([slot]));
    }

    static async handleSocketCharm(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const entityId = br.readMethod9();
        if (!EquipmentHandler.isOwnEntity(client, entityId)) {
            return;
        }

        const gearId = br.readMethod20(11);
        const gearTier = br.readMethod20(2);
        const charmId = br.readMethod20(16);
        const socketIndex = br.readMethod20(2);
        if (gearId <= 0 || charmId <= 0 || socketIndex < 1 || socketIndex > 3) {
            return;
        }

        const equippedGears = EquipmentHandler.ensureEquippedGears(client);
        const gearIndex = EquipmentHandler.findEquippedGearIndex(equippedGears, gearId, gearTier);
        if (gearIndex < 0) {
            return;
        }

        const gear = EquipmentHandler.normalizeGearEntry(equippedGears[gearIndex]);
        const runes = Array.isArray(gear.runes) ? gear.runes.slice(0, 3) : [0, 0, 0];
        while (runes.length < 3) {
            runes.push(0);
        }

        const runeIndex = socketIndex - 1;
        const existingCharmId = Number(runes[runeIndex] ?? 0);
        const isCharmRemover = EquipmentHandler.getCharmPrimaryId(charmId) === CharmID.CharmRemover;
        if (isCharmRemover && existingCharmId <= 0) {
            return;
        }

        if (!EquipmentHandler.decrementOwnedCharm(client.character, charmId)) {
            return;
        }

        if (isCharmRemover) {
            runes[runeIndex] = 0;
            EquipmentHandler.incrementOwnedCharm(client.character, existingCharmId);
        } else {
            runes[runeIndex] = charmId;
        }

        gear.runes = runes;
        equippedGears[gearIndex] = gear;
        EquipmentHandler.upsertInventoryMirror(client.character, gear);
        EquipmentHandler.updateLiveEntity(client);

        const changedSlot = gearIndex + 1;
        EquipmentHandler.persistAndBroadcast(client, entityId, new Set([changedSlot]));
        EquipmentHandler.sendGearToSelf(client);
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

    private static findEquippedGearIndex(equippedGears: GearEntry[], gearId: number, gearTier: number): number {
        const exactIndex = equippedGears.findIndex((entry) =>
            Number(entry?.gearID ?? 0) === gearId &&
            Number(entry?.tier ?? 0) === gearTier
        );
        if (exactIndex >= 0) {
            return exactIndex;
        }

        return equippedGears.findIndex((entry) => Number(entry?.gearID ?? 0) === gearId);
    }

    private static getCharmPrimaryId(charmId: number): number {
        return Math.max(0, Math.floor(Number(charmId ?? 0))) & 0x1ff;
    }

    private static getCharmInventory(character: any): Array<Record<string, number>> {
        const charms = Array.isArray(character?.charms) ? character.charms : [];
        character.charms = charms;
        return charms as Array<Record<string, number>>;
    }

    private static incrementOwnedCharm(character: any, charmId: number): void {
        if (charmId <= 0) {
            return;
        }

        const charms = EquipmentHandler.getCharmInventory(character);
        const entry = charms.find((charm) => Number(charm?.charmID ?? 0) === charmId);
        if (entry) {
            entry.count = Math.max(0, Number(entry.count ?? 0)) + 1;
            return;
        }

        charms.push({ charmID: charmId, count: 1 });
    }

    private static decrementOwnedCharm(character: any, charmId: number): boolean {
        if (charmId <= 0) {
            return false;
        }

        const charms = EquipmentHandler.getCharmInventory(character);
        const index = charms.findIndex((charm) => Number(charm?.charmID ?? 0) === charmId);
        if (index < 0) {
            return false;
        }

        const entry = charms[index];
        const nextCount = Math.max(0, Number(entry.count ?? 0) - 1);
        if (nextCount > 0) {
            entry.count = nextCount;
        } else {
            charms.splice(index, 1);
        }

        return true;
    }

    private static upsertInventoryMirror(character: any, gear: GearEntry): void {
        const inventory = Array.isArray(character?.inventoryGears) ? character.inventoryGears : [];
        character.inventoryGears = inventory;

        const normalizedGear = EquipmentHandler.normalizeGearEntry(gear);
        const index = inventory.findIndex((entry: any) =>
            Number(entry?.gearID ?? 0) === Number(normalizedGear.gearID ?? 0) &&
            Number(entry?.tier ?? 0) === Number(normalizedGear.tier ?? 0)
        );

        const mirrored: GearEntry = {
            ...normalizedGear,
            runes: Array.isArray(normalizedGear.runes) ? [...normalizedGear.runes] : [0, 0, 0],
            colors: Array.isArray(normalizedGear.colors) ? [...normalizedGear.colors] : [0, 0]
        };

        if (index >= 0) {
            inventory[index] = {
                ...(inventory[index] && typeof inventory[index] === 'object' ? inventory[index] : {}),
                ...mirrored
            };
        } else if (Number(mirrored.gearID ?? 0) > 0) {
            inventory.push(mirrored);
        }
    }

    static buildEntityGearUpdatePacket(entityId: number, equippedGears: unknown[]): Buffer {
        const normalizedGears = Array.from({ length: EquipmentHandler.LAST_SLOT }, (_, index) =>
            EquipmentHandler.normalizeGearEntry(
                Array.isArray(equippedGears) ? equippedGears[index] : EquipmentHandler.emptyGearEntry()
            )
        );

        try {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);

        for (let index = 0; index < EquipmentHandler.LAST_SLOT; index++) {
            const gear = normalizedGears[index];
            const gearId = Number(gear.gearID ?? 0);

            bb.writeMethod15(true);
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

                } catch (err) {
            console.error(`[EquipmentHandler] buildEntityGearUpdatePacket FAILED for entity ${entityId}:`, err);
            const fallback = new BitBuffer(false);
            fallback.writeMethod4(entityId);
            for (let i = 0; i < 6; i++) fallback.writeMethod6(0, 1);
            return fallback.toBuffer();
        }
        return bb.toBuffer();
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
        const ownedGear = gearId > 0 ? EquipmentHandler.resolveOwnedGear(client, gearId) : null;
        if (gearId > 0 && !ownedGear) {
            console.warn(`[EquipmentAuthority] rejected unowned gear userId=${client.userId ?? 0} gearId=${gearId} slot=${slot}`);
            return;
        }
        const nextGear = ownedGear
            ? EquipmentHandler.normalizeGearEntry(ownedGear)
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

        const levelMap = GlobalState.levelEntities.get(getClientLevelScope(client));
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
            if (other === client || !other.playerSpawned || !areClientsInSameLevelScope(client, other)) {
                continue;
            }

            other.send(0x30, payload);
        }
    }

    static broadcastGearChange(client: Client, includeSelf: boolean = false): void {
        if (!client.currentLevel || !client.playerSpawned || !client.character || client.clientEntID <= 0) {
            return;
        }

        const payload = EquipmentHandler.buildEntityGearUpdatePacket(
            client.clientEntID,
            Array.isArray(client.character.equippedGears) ? client.character.equippedGears : []
        );

        for (const other of GlobalState.sessionsByToken.values()) {
            if ((!includeSelf && other === client) || !other.playerSpawned || !areClientsInSameLevelScope(client, other)) {
                continue;
            }

            other.send(0xAF, payload);
        }
    }

    static sendGearToSelf(client: Client): void {
        if (!client.playerSpawned || !client.character || client.clientEntID <= 0) {
            return;
        }

        client.send(
            0xAF,
            EquipmentHandler.buildEntityGearUpdatePacket(
                client.clientEntID,
                Array.isArray(client.character.equippedGears) ? client.character.equippedGears : []
            )
        );
    }

    private static persistAndBroadcast(client: Client, entityId: number, changedSlots: Set<number>): void {
        if (!client.character || changedSlots.size === 0) {
            return;
        }

        EquipmentHandler.upsertCharacterSnapshot(client);
        EquipmentHandler.broadcastEquipmentUpdate(client, entityId, changedSlots);
        // broadcastEquipmentUpdate deliberately skips the player who equipped, so without
        // this they never hear their own new set back. The armory only applies the change
        // to its preview doll, so the real entity's equippedGear stayed at whatever the
        // login packet set - which is why the dye screen kept showing the previous set.
        EquipmentHandler.sendGearToSelf(client);
        EntityHandler.refreshPlayerSnapshot(client);
        client.combatStatsDirty = true;
        client.allowDirtyCombatStatsRegen = true;
        client.lastCombatStatsRefreshRequestAt = Date.now();
        CharacterSync.requestCombatStatsRefresh(client);

        if (!client.userId) {
            return;
        }
        if (typeof client.scheduleCharacterSave === 'function') {
            client.scheduleCharacterSave('equipment update');
            return;
        }
        void db.saveCharacters(client.userId, client.characters).catch((error) => {
            console.error('[EquipmentHandler] Deferred equipment save failed:', error);
        });
    }
}
