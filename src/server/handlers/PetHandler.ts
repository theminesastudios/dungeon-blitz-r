import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { JsonAdapter } from '../database/JsonAdapter';
import { PetConfig } from '../core/PetConfig';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { EntityHandler } from './EntityHandler';
import { areClientsInSameLevelScope, getClientLevelScope } from '../core/LevelScope';
import { ConsumableID } from '../data/runtime/Consumables';

const db = new JsonAdapter();

export class PetHandler {
    private static readonly MOUNT_REASSERT_DELAYS_MS = [0, 300, 1200, 2500, 4000];
    private static readonly PET_ACTIVE_BONUS_BASE_RATE = 0.09;
    private static readonly PET_BONUS_RATE_PER_LEVEL = 0.01;
    private static readonly MAX_PASSIVE_PET_SLOTS = 3;
    private static readonly HATCHERY_RANK0_WEIGHT = 0.75;
    private static readonly HATCHERY_RANK1_WEIGHT = 0.175;
    private static readonly HATCHERY_RANK2_WEIGHT = 0.075;
    private static readonly HATCHED_EGG_PET_FOOD_AMOUNT = 1;
    private static readonly eggReadyTimers = new WeakMap<Client, NodeJS.Timeout>();

    private static sendMammothIdolUpdate(client: Client): void {
        if (!client.character) {
            return;
        }

        const bb = new BitBuffer(false);
        bb.writeMethod4(Number(client.character.mammothIdols ?? 0));
        bb.writeMethod4(0);
        bb.writeMethod11(client.character.showHigher ? 1 : 0, 1);
        client.sendBitBuffer(0xA1, bb);
    }

    private static sendGoldLoss(client: Client, amount: number): void {
        if (amount <= 0) {
            return;
        }

        const bb = new BitBuffer(false);
        bb.writeMethod4(amount);
        client.sendBitBuffer(0xB4, bb);
    }

    private static sendConsumableUpdate(client: Client, consumableId: number, count: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(Math.max(0, consumableId), 5);
        bb.writeMethod4(Math.max(0, count));
        client.sendBitBuffer(0x10C, bb);
    }

    private static sendConsumableReward(client: Client, consumableId: number, amount: number, newTotal: number): void {
        PetHandler.sendConsumableUpdate(client, consumableId, newTotal);

        const reward = new BitBuffer(false);
        reward.writeMethod6(Math.max(0, consumableId), 5);
        reward.writeMethod4(Math.max(0, amount));
        reward.writeMethod15(false);
        client.sendBitBuffer(0x10B, reward);
    }

    private static sendPetXpUpdate(client: Client, xpAmount: number): void {
        if (xpAmount <= 0) {
            return;
        }

        const bb = new BitBuffer(false);
        bb.writeMethod4(xpAmount);
        client.sendBitBuffer(0xF2, bb);
    }

    private static sendPetTrainingComplete(client: Client, petTypeId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(Math.max(0, petTypeId), 7);
        bb.writeMethod4(Math.floor(Date.now() / 1000));
        client.sendBitBuffer(0xEE, bb);
    }

    private static syncPetLevelReferences(character: any, typeId: number, specialId: number, level: number): void {
        const equipped = [
            character?.activePet,
            ...(Array.isArray(character?.restingPets) ? character.restingPets : [])
        ];

        for (const pet of equipped) {
            const equippedSpecialId = Number(pet?.special_id ?? 0);
            if (
                Number(pet?.typeID ?? pet?.petID ?? 0) === typeId &&
                (equippedSpecialId <= 0 || equippedSpecialId === specialId)
            ) {
                pet.level = level;
            }
        }
    }

    static getActivePetRecord(character: any): any | null {
        if (!character) {
            return null;
        }

        PetHandler.normalizePetCollection(character);
        const activePet = character.activePet ?? {};
        const petTypeId = Number(activePet.typeID ?? activePet.petID ?? 0);
        const petSpecialId = Number(activePet.special_id ?? 0);
        if (petTypeId <= 0) {
            return null;
        }

        const pets = Array.isArray(character.pets) ? character.pets : [];
        return pets.find((pet: any) => {
            const typeId = Number(pet?.typeID ?? 0);
            const specialId = Number(pet?.special_id ?? 0);
            if (typeId !== petTypeId) {
                return false;
            }
            return petSpecialId <= 0 || specialId === petSpecialId;
        }) ?? null;
    }

    static getEquippedPetRecords(character: any): any[] {
        if (!character) {
            return [];
        }

        PetHandler.normalizePetCollection(character);
        const pets = Array.isArray(character.pets) ? character.pets : [];
        const equippedSlots = [
            character.activePet,
            ...(Array.isArray(character.restingPets)
                ? character.restingPets.slice(0, PetHandler.MAX_PASSIVE_PET_SLOTS)
                : [])
        ];
        const equipped: any[] = [];
        const seen = new Set<string>();

        for (const slot of equippedSlots) {
            const petTypeId = Number(slot?.typeID ?? slot?.petID ?? 0);
            const petSpecialId = Number(slot?.special_id ?? 0);
            if (petTypeId <= 0) {
                continue;
            }

            const pet = pets.find((candidate: any) => {
                const typeId = Number(candidate?.typeID ?? 0);
                const specialId = Number(candidate?.special_id ?? 0);
                if (typeId !== petTypeId) {
                    return false;
                }
                return petSpecialId <= 0 || specialId === petSpecialId;
            });
            if (!pet) {
                continue;
            }

            const key = `${Number(pet.typeID ?? 0)}:${Number(pet.special_id ?? 0)}`;
            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            equipped.push(pet);
        }

        return equipped;
    }

    static normalizePetCollection(character: any): any[] {
        if (!character) {
            return [];
        }

        const pets = Array.isArray(character.pets) ? character.pets : [];
        const normalized: any[] = [];
        const seen = new Set<string>();

        for (const rawPet of pets) {
            if (!rawPet || typeof rawPet !== 'object') {
                continue;
            }

            const typeID = Number(rawPet.typeID ?? rawPet.petID ?? 0);
            const specialId = Number(rawPet.special_id ?? 0);
            if (!Number.isFinite(typeID) || typeID <= 0) {
                continue;
            }

            const key = `${typeID}:${Number.isFinite(specialId) ? specialId : 0}`;
            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            rawPet.typeID = typeID;
            rawPet.special_id = Number.isFinite(specialId) ? specialId : 0;
            rawPet.level = Math.max(1, Number(rawPet.level ?? 1));
            rawPet.xp = Math.max(0, Number(rawPet.xp ?? 0));
            normalized.push(rawPet);
        }

        character.pets = normalized;

        const ownsPet = (candidate: any): boolean => {
            const typeID = Number(candidate?.typeID ?? candidate?.petID ?? 0);
            const specialId = Number(candidate?.special_id ?? 0);
            if (typeID <= 0) {
                return false;
            }
            return normalized.some((pet) =>
                Number(pet.typeID ?? 0) === typeID &&
                (specialId <= 0 || Number(pet.special_id ?? 0) === specialId)
            );
        };

        if (character.activePet && !ownsPet(character.activePet)) {
            character.activePet = {};
        }

        if (Array.isArray(character.restingPets)) {
            const selected = new Set<string>();
            if (ownsPet(character.activePet)) {
                selected.add(`${Number(character.activePet.typeID ?? character.activePet.petID ?? 0)}:${Number(character.activePet.special_id ?? 0)}`);
            }

            character.restingPets = character.restingPets.filter((pet: any) => {
                if (!ownsPet(pet)) {
                    return false;
                }
                const key = `${Number(pet.typeID ?? pet.petID ?? 0)}:${Number(pet.special_id ?? 0)}`;
                if (selected.has(key)) {
                    return false;
                }
                selected.add(key);
                return true;
            });
        }

        return normalized;
    }

    private static getOwnedPetTypeIds(character: any): Set<number> {
        return new Set<number>(
            PetHandler.normalizePetCollection(character)
                .map((pet: any) => Number(pet?.typeID ?? 0))
                .filter((typeId: number) => typeId > 0)
        );
    }

    private static pickRandomPetDef(pets: any[]): any | undefined {
        if (pets.length === 0) {
            return undefined;
        }

        const roll = Math.random();
        const randomValue = Math.max(0, Math.min(Number.isFinite(roll) ? roll : 0, 0.999999999));
        return pets[Math.floor(randomValue * pets.length)] ?? pets[0];
    }

    private static addConsumable(character: any, consumableId: number, amount: number): number {
        const consumables = Array.isArray(character?.consumables) ? character.consumables : [];
        const entry = consumables.find((consumable: any) => Number(consumable?.consumableID ?? 0) === consumableId);
        if (entry) {
            entry.count = Math.max(0, Number(entry.count ?? 0) + amount);
        } else {
            consumables.push({
                consumableID: consumableId,
                count: Math.max(0, amount)
            });
        }
        character.consumables = consumables;
        return Number(consumables.find((consumable: any) => Number(consumable?.consumableID ?? 0) === consumableId)?.count ?? 0);
    }

    private static removeHatchedEggFromSlot(character: any, slotIndex: number): void {
        const ownedEggs = PetHandler.normalizeOwnedEggIds(character);
        if (slotIndex >= 0 && slotIndex < ownedEggs.length) {
            ownedEggs.splice(slotIndex, 1);
        }
        character.OwnedEggsID = ownedEggs;
        PetHandler.resetEggHatchery(character);
    }

    static getEquippedPetBonusRates(character: any): { goldFind: number; itemFind: number; craftFind: number; expBonus: number } {
        const bonuses = {
            goldFind: 0,
            itemFind: 0,
            craftFind: 0,
            expBonus: 0
        };

        for (const pet of PetHandler.getEquippedPetRecords(character)) {
            const petDef = PetConfig.getPetDef(Number(pet.typeID ?? 0));
            if (!petDef) {
                continue;
            }

            const petLevel = Math.max(0, Number(pet.level ?? 1));
            const bonus = petLevel > 0
                ? PetHandler.PET_ACTIVE_BONUS_BASE_RATE + petLevel * PetHandler.PET_BONUS_RATE_PER_LEVEL
                : 0;

            if (petDef.GoldFind) bonuses.goldFind += bonus;
            if (petDef.ItemFind) bonuses.itemFind += bonus;
            if (petDef.CraftFind) bonuses.craftFind += bonus;
            if (petDef.ExpBonus) bonuses.expBonus += bonus;
        }

        return bonuses;
    }

    static getActivePetBonusRates(character: any): { goldFind: number; itemFind: number; craftFind: number; expBonus: number } {
        return PetHandler.getEquippedPetBonusRates(character);
    }

    static applyActivePetExperience(client: Client, xpAmount: number, bonusLevelUps: number = 0): boolean {
        if (!client.character || xpAmount <= 0) {
            return false;
        }

        const pet = PetHandler.getActivePetRecord(client.character);
        if (!pet) {
            return false;
        }

        pet.xp = Math.max(0, Number(pet.xp ?? 0) + xpAmount);
        if (bonusLevelUps > 0) {
            pet.level = Math.min(20, Math.max(1, Number(pet.level ?? 1) + bonusLevelUps));
        }

        if (client.character.activePet && Number(client.character.activePet.typeID ?? 0) === Number(pet.typeID ?? 0)) {
            client.character.activePet.xp = pet.xp;
            client.character.activePet.level = pet.level;
            client.character.activePet.special_id = Number(pet.special_id ?? client.character.activePet.special_id ?? 0);
        }

        PetHandler.sendPetXpUpdate(client, xpAmount);
        return true;
    }

    static normalizeMountState(character: any): number[] {
        const mountIds = Array.isArray(character?.mounts) ? character!.mounts : [];
        const normalized: number[] = [];
        const seen = new Set<number>();

        for (const rawMountId of mountIds) {
            const mountId = Number(rawMountId ?? 0);
            if (!Number.isFinite(mountId) || mountId <= 0 || seen.has(mountId)) {
                continue;
            }

            seen.add(mountId);
            normalized.push(mountId);
        }

        const equippedMount = Number(character?.equippedMount ?? 0);
        if (Number.isFinite(equippedMount) && equippedMount > 0 && !seen.has(equippedMount)) {
            normalized.push(equippedMount);
        }

        if (character) {
            character.mounts = normalized;
        }

        return normalized;
    }

    private static normalizeEquippedPetSlot(slot: any): { typeID: number; special_id: number } {
        return {
            typeID: Math.max(0, Math.round(Number(slot?.typeID ?? slot?.petID ?? 0) || 0)),
            special_id: Math.max(0, Math.round(Number(slot?.special_id ?? slot?.uniqueID ?? 0) || 0))
        };
    }

    private static sameEquippedPetSlot(left: any, right: any): boolean {
        const normalizedLeft = PetHandler.normalizeEquippedPetSlot(left);
        const normalizedRight = PetHandler.normalizeEquippedPetSlot(right);
        return normalizedLeft.typeID === normalizedRight.typeID &&
            normalizedLeft.special_id === normalizedRight.special_id;
    }

    static syncEquippedCompanionState(target: any, source: any): boolean {
        if (!target || !source) {
            return false;
        }

        let changed = false;

        if (source.equippedMount !== undefined) {
            const sourceMount = Math.max(0, Math.round(Number(source.equippedMount ?? 0) || 0));
            const targetMount = Math.max(0, Math.round(Number(target.equippedMount ?? 0) || 0));
            if (sourceMount !== targetMount) {
                target.equippedMount = sourceMount;
                changed = true;
            }
        }

        if (source.activePet !== undefined) {
            const sourceActivePet = PetHandler.normalizeEquippedPetSlot(source.activePet);
            if (!PetHandler.sameEquippedPetSlot(target.activePet, sourceActivePet)) {
                target.activePet = sourceActivePet.typeID > 0 ? sourceActivePet : {};
                changed = true;
            }
        }

        const sourceRestingPets = Array.isArray(source.restingPets)
            ? source.restingPets
                .map((pet: any) => PetHandler.normalizeEquippedPetSlot(pet))
                .filter((pet: { typeID: number; special_id: number }) => pet.typeID > 0)
                .slice(0, PetHandler.MAX_PASSIVE_PET_SLOTS)
            : [];
        const targetRestingPets = Array.isArray(target.restingPets)
            ? target.restingPets.map((pet: any) => PetHandler.normalizeEquippedPetSlot(pet))
            : [];
        if (Array.isArray(source.restingPets) && (
            sourceRestingPets.length !== targetRestingPets.length ||
            sourceRestingPets.some((pet: { typeID: number; special_id: number }, index: number) =>
                !PetHandler.sameEquippedPetSlot(targetRestingPets[index], pet)
            )
        )) {
            target.restingPets = sourceRestingPets;
            changed = true;
        }

        PetHandler.normalizeMountState(target);
        PetHandler.normalizePetCollection(target);

        return changed;
    }

    static armMountTravelProtection(client: Client, durationMs: number = 4000, reassert: boolean = false): void {
        const mountId = Number(client.character?.equippedMount ?? 0);
        if (mountId <= 0) {
            return;
        }

        client.mountTransferGraceUntil = Math.max(
            Number(client.mountTransferGraceUntil ?? 0),
            Date.now() + Math.max(0, durationMs)
        );

        if (reassert) {
            PetHandler.reassertEquippedMount(client);
        }
    }

    private static shouldIgnoreTransientTravelUnequip(client: Client, mountId: number): boolean {
        if (mountId !== 0) {
            return false;
        }

        const hasEquippedMount = Number(client.character?.equippedMount ?? 0) > 0;
        if (!hasEquippedMount) {
            return false;
        }

        if (!client.playerSpawned) {
            return true;
        }

        return Date.now() < Number(client.mountTransferGraceUntil ?? 0);
    }

    private static reassertEquippedMount(client: Client): void {
        const entityId = Number(client.clientEntID ?? 0);
        const mountId = Number(client.character?.equippedMount ?? 0);
        if (entityId <= 0 || mountId <= 0) {
            return;
        }

        const levelName = client.currentLevel;
        const levelScope = getClientLevelScope(client);
        const token = client.token;

        for (const delayMs of PetHandler.MOUNT_REASSERT_DELAYS_MS) {
            setTimeout(() => {
                if (
                    client.clientEntID !== entityId ||
                    Number(client.character?.equippedMount ?? 0) !== mountId ||
                    client.token !== token
                ) {
                    return;
                }

                PetHandler.sendMountEquipPacket(client, entityId, mountId);

                if (!levelName || !client.playerSpawned || getClientLevelScope(client) !== levelScope) {
                    return;
                }

                const payload = PetHandler.buildMountEquipPacket(entityId, mountId);
                for (const other of GlobalState.sessionsByToken.values()) {
                    if (other === client || !other.playerSpawned || !areClientsInSameLevelScope(client, other)) {
                        continue;
                    }

                    other.send(0xB2, payload);
                }
            }, delayMs);
        }
    }

    static buildMountEquipPacket(entityId: number, mountId: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod6(Math.max(0, Number(mountId ?? 0)), 7);
        return bb.toBuffer();
    }

    static sendMountEquipPacket(client: Client, entityId: number, mountId: number): void {
        if (entityId <= 0) {
            return;
        }

        client.send(0xB2, PetHandler.buildMountEquipPacket(entityId, mountId));
    }

    private static updateLiveMount(client: Client): void {
        if (!client.character || client.clientEntID <= 0) {
            return;
        }

        const localEntity = client.entities.get(client.clientEntID);
        if (localEntity && typeof localEntity === 'object') {
            localEntity.equippedMount = Number(client.character.equippedMount ?? 0);
        }

        if (!client.currentLevel) {
            return;
        }

        const levelMap = GlobalState.levelEntities.get(getClientLevelScope(client));
        const levelEntity = levelMap?.get(client.clientEntID);
        if (levelEntity && typeof levelEntity === 'object') {
            levelEntity.equippedMount = Number(client.character.equippedMount ?? 0);
        }
    }

    static async handleMountEquipPacket(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        PetHandler.normalizeMountState(client.character);

        const br = new BitReader(data);
        const entityId = br.readMethod4();
        const mountId = br.readMethod6(7);

        if (entityId > 0 && client.clientEntID > 0 && entityId !== client.clientEntID) {
            return;
        }

        if (PetHandler.shouldIgnoreTransientTravelUnequip(client, mountId)) {
            const graceRemainingMs = Math.max(0, Number(client.mountTransferGraceUntil ?? 0) - Date.now());
            console.log(
                `[PetHandler] Ignoring transient travel mount clear for ${client.character?.name ?? 'unknown'} in ${client.currentLevel || '(loading)'} grace=${graceRemainingMs}ms spawned=${client.playerSpawned}`
            );
            PetHandler.reassertEquippedMount(client);
            return;
        }

        if (mountId > 0 && !PetHandler.normalizeMountState(client.character).includes(mountId)) {
            return;
        }

        if (Number(client.character.equippedMount ?? 0) === mountId) {
            PetHandler.updateLiveMount(client);
            if (client.currentLevel && client.playerSpawned) {
                PetHandler.sendMountEquipPacket(client, client.clientEntID, mountId);
            }
            return;
        }

        client.character.equippedMount = mountId;
        if (mountId > 0) {
            client.mountTransferGraceUntil = 0;
        }
        PetHandler.updateLiveMount(client);
        await PetHandler.saveCharacter(client);

        if (!client.currentLevel || !client.playerSpawned) {
            return;
        }

        PetHandler.sendMountEquipPacket(client, client.clientEntID, mountId);

        for (const other of GlobalState.sessionsByToken.values()) {
            if (other === client || !other.playerSpawned || !areClientsInSameLevelScope(client, other)) {
                continue;
            }

            other.send(0xB2, data);
        }

        EntityHandler.refreshPlayerSnapshot(client);
    }

    static async handleEquipPets(client: Client, data: Buffer): Promise<void> { // Removed <void> for shorter diff if needed, but keeping consistent
        const br = new BitReader(data);
        // Packet starts at index 4
        
        const pets: { typeID: number, uniqueID: number }[] = [];
        
        for (let i = 0; i < 4; i++) {
            const typeID = br.readMethod6(7);
            const uniqueID = br.readMethod9();
            pets.push({ typeID, uniqueID });
        }

        const active = pets[0];
        const resting = pets.slice(1);

        if (client.character) {
            client.character.activePet = {
                typeID: active.typeID,
                special_id: active.uniqueID
            };

            client.character.restingPets = resting.map(p => ({
                typeID: p.typeID,
                special_id: p.uniqueID
            }));

            if (client.userId) {
                await PetHandler.saveCharacter(client);
            }

            if (client.playerSpawned && client.currentLevel) {
                EntityHandler.refreshPlayerSnapshot(client);
            }
        }
    }

    static async handleRequestHatcheryEggs(client: Client, data: Buffer): Promise<void> {
        if (!client.character) return;
        await PetHandler.syncCompletedEggHatch(client);
        
        const hatchery = PetHandler.ensureAvailableHatcheryEggs(client.character);
        if (hatchery.changed) {
            if (client.userId) {
                await PetHandler.saveCharacter(client);
            }
        }

        client.character.EggNotifySent = false;
        
        const pkt = PetHandler.buildHatcheryPacket(hatchery.owned, hatchery.resetTime);
        client.sendBitBuffer(0xE5, pkt);
    }
    
    private static async saveCharacter(client: Client) {
        if (client.userId && client.character) {
             const chars = await db.loadCharacters(client.userId);
             const idx = chars.findIndex(c => c.name === client.character?.name);
             if (idx !== -1) {
                 chars[idx] = client.character; // Update in-memory copy before saving
             } else {
                 chars.push(client.character);
             }
             client.characters = chars;
             await db.saveCharacters(client.userId, chars);
        }
    }

    private static pickDailyEggs(count: number): number[] {
        const chosen: number[] = [];
        for (let i = 0; i < count; i++) {
            const eggId = PetHandler.pickDailyEggId();
            if (eggId > 0) {
                chosen.push(eggId);
            }
        }
        return chosen;
    }

    private static pickDailyEggId(): number {
        const validEggs = PetConfig.EGG_TYPES.filter((egg) => Number(egg?.EggID ?? 0) > 0);
        if (validEggs.length === 0) {
            return 0;
        }

        const rank = PetHandler.pickDailyEggRank(Math.random());
        const rankEggs = validEggs.filter((egg) => Number(egg?.EggRank ?? 0) === rank);
        const pool = rankEggs.length > 0 ? rankEggs : validEggs;
        const idx = Math.floor(Math.random() * pool.length);
        return Number(pool[idx]?.EggID ?? 0);
    }

    private static pickDailyEggRank(randomValue: number): number {
        const roll = Number.isFinite(randomValue) ? Math.max(0, Math.min(randomValue, 0.999999999)) : 0;
        if (roll < PetHandler.HATCHERY_RANK2_WEIGHT) {
            return 2;
        }
        if (roll < PetHandler.HATCHERY_RANK2_WEIGHT + PetHandler.HATCHERY_RANK1_WEIGHT) {
            return 1;
        }
        return 0;
    }

    static ensureAvailableHatcheryEggs(
        character: any,
        now: number = Math.floor(Date.now() / 1000)
    ): { owned: number[]; resetTime: number; changed: boolean } {
        const previousOwnedLength = Array.isArray(character?.OwnedEggsID) ? character.OwnedEggsID.length : 0;
        let owned = PetHandler.normalizeOwnedEggIds(character);
        let resetTime = Number(character?.EggResetTime ?? 0);
        if (!Number.isFinite(resetTime) || resetTime < 0) {
            resetTime = 0;
        }
        let changed = previousOwnedLength !== owned.length;

        if (now >= resetTime || owned.length === 0) {
            const maxSlots = PetConfig.MAX_EGG_SLOTS;
            const openSlots = maxSlots - owned.length;

            if (openSlots > 0) {
                const newCount = Math.min(openSlots, 3);
                const addedEggs = PetHandler.pickDailyEggs(newCount);
                owned = owned.concat(addedEggs);
                console.log(`[PetHandler] Added eggs: ${addedEggs}`);
            }

            resetTime = now + PetConfig.NEW_EGG_SET_TIME;
            changed = true;
        }

        if (character) {
            character.OwnedEggsID = owned;
            character.EggResetTime = resetTime;
        }

        return { owned, resetTime, changed };
    }

    private static buildHatcheryPacket(eggs: number[], resetTime: number): BitBuffer {
        const bb = new BitBuffer();
        const maxSlots = PetConfig.MAX_EGG_SLOTS;
        
        const trimmed = eggs.slice(0, maxSlots);
        const padded = trimmed.concat(new Array(maxSlots - trimmed.length).fill(0));
        
        bb.writeMethod6(maxSlots, 6);
        
        for (const eid of padded) {
            bb.writeMethod6(eid, 6);
        }
        
        bb.writeMethod4(resetTime);
        return bb;
    }

    static normalizeOwnedEggIds(character: any): number[] {
        const eggs = Array.isArray(character?.OwnedEggsID) ? character.OwnedEggsID : [];
        const normalized = eggs
            .map((eggId: unknown) => Number(eggId ?? 0))
            .filter((eggId: number) => (
                Number.isInteger(eggId) &&
                eggId > 0 &&
                eggId < 64 &&
                (PetConfig.EGG_TYPES.length === 0 || Boolean(PetConfig.getEggDef(eggId)))
            ));

        if (character) {
            character.OwnedEggsID = normalized;
        }

        return normalized;
    }

    private static getNormalizedEggHatchery(character: any): { EggID: number; ReadyTime: number; slotIndex: number } | null {
        const eggData = character?.EggHachery;
        if (!eggData || typeof eggData !== 'object') {
            return null;
        }

        const normalized = {
            EggID: Number(eggData.EggID ?? 0),
            ReadyTime: Number(eggData.ReadyTime ?? 0),
            slotIndex: Number(eggData.slotIndex ?? 0)
        };

        character.EggHachery = normalized;
        return normalized;
    }

    private static resetEggHatchery(character: any): void {
        if (!character) {
            return;
        }

        character.EggHachery = {
            EggID: 0,
            ReadyTime: 0,
            slotIndex: 0
        };
        character.activeEggCount = 0;
    }

    private static sendEggReadyPacket(client: Client, eggId: number): void {
        const bb = new BitBuffer();
        bb.writeMethod6(Math.max(0, eggId), 6);
        client.sendBitBuffer(0xE7, bb);
    }

    private static clearEggReadyTimer(client: Client): void {
        const timer = PetHandler.eggReadyTimers.get(client);
        if (timer) {
            clearTimeout(timer);
            PetHandler.eggReadyTimers.delete(client);
        }
    }

    private static scheduleEggReadyTimer(client: Client, readyTime: number): void {
        PetHandler.clearEggReadyTimer(client);

        const now = Math.floor(Date.now() / 1000);
        const delayMs = Math.max(0, readyTime - now) * 1000;
        const timer = setTimeout(() => {
            PetHandler.eggReadyTimers.delete(client);
            void PetHandler.syncCompletedEggHatch(client);
        }, delayMs);
        timer.unref?.();
        PetHandler.eggReadyTimers.set(client, timer);
    }

    static async syncCompletedEggHatch(
        client: Client,
        now: number = Math.floor(Date.now() / 1000)
    ): Promise<boolean> {
        if (!client.character) {
            return false;
        }

        const eggData = PetHandler.getNormalizedEggHatchery(client.character);
        if (!eggData || eggData.EggID <= 0 || eggData.ReadyTime <= 0 || eggData.ReadyTime > now) {
            return false;
        }

        eggData.ReadyTime = 0;
        client.character.EggHachery = eggData;
        PetHandler.clearEggReadyTimer(client);

        if (client.userId) {
            await PetHandler.saveCharacter(client);
        }

        PetHandler.sendEggReadyPacket(client, eggData.EggID);
        return true;
    }

    static async handleTrainPet(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const typeID = br.readMethod6(7);
        const uniqueID = br.readMethod9();
        const nextRank = br.readMethod6(6);
        const useIdols = br.readMethod15();

        if (!client.character) return;

        const pets = PetHandler.normalizePetCollection(client.character);
        const pet = pets.find((entry: any) =>
            Number(entry?.typeID ?? 0) === typeID &&
            Number(entry?.special_id ?? 0) === uniqueID
        );
        if (!pet) return;

        const currentRank = Math.max(1, Number(pet.level ?? 1));
        if (nextRank !== currentRank + 1 || nextRank >= PetConfig.TRAINING_GOLD_COST.length) {
            return;
        }
        
        const goldCost = PetConfig.TRAINING_GOLD_COST[nextRank] || 0;
        const idolCost = PetConfig.TRAINING_IDOL_COST[nextRank] || 0;

        if (useIdols) {
            if ((client.character.mammothIdols || 0) < idolCost) return;
            client.character.mammothIdols = (client.character.mammothIdols || 0) - idolCost;
            PetHandler.sendMammothIdolUpdate(client);
        } else {
            if ((client.character.gold || 0) < goldCost) return;
            client.character.gold = (client.character.gold || 0) - goldCost;
            PetHandler.sendGoldLoss(client, goldCost);
        }

        pet.level = nextRank;
        PetHandler.syncPetLevelReferences(client.character, typeID, uniqueID, nextRank);
        client.character.trainingPet = [];

        await PetHandler.saveCharacter(client);
        PetHandler.sendPetTrainingComplete(client, typeID);
    }

    static async handlePetTrainingCollect(client: Client, data: Buffer): Promise<void> {
        if (!client.character) return;
        
        const tpList = client.character.trainingPet || [];
        if (tpList.length === 0) return;

        const tp = tpList[0];
        const readyTime = Number(tp.trainingTime ?? 0);
        const now = Math.floor(Date.now() / 1000);
        if (readyTime > 0 && readyTime > now) {
            return;
        }

        const typeID = tp.typeID;
        const specialID = tp.special_id;

        const pets = client.character.pets || [];
        for (const pet of pets) {
            if (pet.typeID === typeID && pet.special_id === specialID) {
                pet.level = (pet.level || 0) + 1;
                break;
            }
        }
        
        // Update active pet if it's the one trained
        // Note: activePet stores only type/id usually, but updating level here ensures sync if stored.
        
        client.character.trainingPet = [];

        await PetHandler.saveCharacter(client);
        
        // Notify client if needed? Python handle_pet_training_collect doesn't send packet back immediately, 
        // just saves.
    }

    static async handlePetTrainingCancel(client: Client, data: Buffer): Promise<void> {
        if (!client.character) return;
        client.character.trainingPet = [];
        await PetHandler.saveCharacter(client);
    }
    
    static async handlePetSpeedUp(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const idolCost = br.readMethod9();
        
        if (!client.character) return;
        if ((client.character.mammothIdols || 0) < idolCost) return;
        
        client.character.mammothIdols = (client.character.mammothIdols || 0) - idolCost;
        PetHandler.sendMammothIdolUpdate(client);
        
        const tpList = client.character.trainingPet || [];
        if (tpList.length > 0) {
            tpList[0].trainingTime = 0;
            const petType = tpList[0].typeID;
            
            await PetHandler.saveCharacter(client);
            
            PetHandler.sendPetTrainingComplete(client, petType);
        }
    }

    static async handleEggHatch(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const slotIndex = br.readMethod20(4);
        const useIdols = br.readMethod15();

        if (!client.character) return;
        const owned = PetHandler.normalizeOwnedEggIds(client.character);
        if (slotIndex < 0 || slotIndex >= owned.length) {
            return;
        }

        const eggID = Number(owned[slotIndex] ?? 0);
        const eggDef = PetConfig.getEggDef(eggID);
        if (!eggDef) {
            return;
        }

        const goldCost = PetConfig.EGG_GOLD_COST[slotIndex] || 0;
        const idolCost = PetConfig.EGG_IDOL_COST[slotIndex] || 0;

        if (useIdols) {
            if ((client.character.mammothIdols || 0) < idolCost) {
                return;
            }
            client.character.mammothIdols = (client.character.mammothIdols || 0) - idolCost;
            PetHandler.sendMammothIdolUpdate(client);
        } else {
            if ((client.character.gold || 0) < goldCost) {
                return;
            }
            client.character.gold = (client.character.gold || 0) - goldCost;
            PetHandler.sendGoldLoss(client, goldCost);
        }

        const eggRank = eggDef.EggRank || 0;
        const hasPets = (client.character.pets && client.character.pets.length > 0);
        let duration = 0;
        
        if (!hasPets) {
            duration = 180;
        } else {
            duration = PetConfig.getEggHatchTime(eggRank);
        }

        const now = Math.floor(Date.now() / 1000);
        const readyTime = now + duration;

        client.character.EggHachery = {
            EggID: eggID,
            ReadyTime: readyTime,
            slotIndex: slotIndex
        };
        client.character.activeEggCount = 1;
        
        await PetHandler.saveCharacter(client);
        PetHandler.scheduleEggReadyTimer(client, readyTime);
    }
    
    static async handleEggSpeedUp(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const idolCost = br.readMethod9();
        
        if (!client.character) return;
        if ((client.character.mammothIdols || 0) < idolCost) {
            return;
        }
        
        client.character.mammothIdols = (client.character.mammothIdols || 0) - idolCost;
        PetHandler.sendMammothIdolUpdate(client);
        
        const eggData = PetHandler.getNormalizedEggHatchery(client.character);
        if (eggData && eggData.EggID > 0) {
            PetHandler.clearEggReadyTimer(client);
            eggData.ReadyTime = 0;
            client.character.EggHachery = eggData;
            await PetHandler.saveCharacter(client);
            
            PetHandler.sendEggReadyPacket(client, eggData.EggID);
            return;
        }
    }

    static async handleCollectHatchedEgg(client: Client, data: Buffer): Promise<void> {
        if (!client.character) return;
        
        const eggData = PetHandler.getNormalizedEggHatchery(client.character);
        if (!eggData || eggData.EggID <= 0) {
            return;
        }

        const readyTime = Number(eggData.ReadyTime ?? 0);
        const now = Math.floor(Date.now() / 1000);
        if (readyTime > 0 && readyTime > now) {
            return;
        }

        const eggID = Number(eggData.EggID ?? 0);
        const slotIndex = Number(eggData.slotIndex ?? 0);
        const ownedPetTypes = PetHandler.getOwnedPetTypeIds(client.character);
        const unownedEggPets = PetConfig.getHatchablePetsForEgg(eggID).filter((pet) =>
            !ownedPetTypes.has(Number(pet?.PetID ?? 0))
        );

        const petDef = PetHandler.pickRandomPetDef(unownedEggPets);
        if (!petDef) {
            const newTotal = PetHandler.addConsumable(
                client.character,
                ConsumableID.PetFood,
                PetHandler.HATCHED_EGG_PET_FOOD_AMOUNT
            );
            PetHandler.removeHatchedEggFromSlot(client.character, slotIndex);
            PetHandler.clearEggReadyTimer(client);

            await PetHandler.saveCharacter(client);

            PetHandler.sendConsumableReward(
                client,
                ConsumableID.PetFood,
                PetHandler.HATCHED_EGG_PET_FOOD_AMOUNT,
                newTotal
            );
            const pkt = PetHandler.buildHatcheryPacket(PetHandler.normalizeOwnedEggIds(client.character), client.character.EggResetTime || 0);
            client.sendBitBuffer(0xE5, pkt);
            return;
        }

        const petTypeID = Number(petDef.PetID ?? eggID);
        const startingRank = 1;
        
        const pets = client.character.pets || [];
        const maxSpecial = pets.reduce((max: number, p: any) => Math.max(max, p.special_id || 0), 0);
        const specialID = maxSpecial + 1;
        
        pets.push({
            typeID: petTypeID,
            special_id: specialID,
            level: startingRank,
            xp: 0
        });
        client.character.pets = pets;
        
        PetHandler.removeHatchedEggFromSlot(client.character, slotIndex);
        PetHandler.clearEggReadyTimer(client);
        
        await PetHandler.saveCharacter(client);
        
        // 0x37 New Pet
        const bb = new BitBuffer();
        bb.writeMethod6(petTypeID, 7);
        bb.writeMethod4(specialID);
        bb.writeMethod6(startingRank, 6);
        bb.writeMethod15(false);
        client.sendBitBuffer(0x37, bb);
        
        // 0xE5 Refresh Hatchery
        const pkt = PetHandler.buildHatcheryPacket(PetHandler.normalizeOwnedEggIds(client.character), client.character.EggResetTime || 0);
        client.sendBitBuffer(0xE5, pkt);
    }

    static async handleCancelEggHatch(client: Client, data: Buffer): Promise<void> {
        if (!client.character) return;
        PetHandler.clearEggReadyTimer(client);
        PetHandler.resetEggHatchery(client.character);
        await PetHandler.saveCharacter(client);
    }

    static async handleUseConsumable(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const consumableId = br.readMethod20(5);
        const consumableDef = GameData.CONSUMABLES.find((consumable) => Number(consumable?.ConsumableID ?? 0) === consumableId);
        if (!consumableDef) {
            return;
        }

        if (String(consumableDef.Type ?? '') !== 'PetFood') {
            return;
        }

        const consumables = Array.isArray(client.character.consumables) ? client.character.consumables : [];
        const entry = consumables.find((consumable: any) => Number(consumable?.consumableID ?? 0) === consumableId);
        if (!entry || Number(entry.count ?? 0) <= 0) {
            return;
        }

        const xpAmount = Math.max(0, Number(consumableDef.Magnitude ?? 0));
        const bonusLevels = String(consumableDef.ConsumableName ?? '') === 'RarePetFood' ? 1 : 0;
        const applied = PetHandler.applyActivePetExperience(client, xpAmount, bonusLevels);
        if (!applied) {
            return;
        }

        entry.count = Math.max(0, Number(entry.count ?? 0) - 1);
        client.character.consumables = consumables;
        PetHandler.sendConsumableUpdate(client, consumableId, Number(entry.count ?? 0));
        await PetHandler.saveCharacter(client);
    }

    static spawnPet(client: Client): void {
        const char = client.character;
        if (!char) {
            console.log("[PetHandler] spawnPet: No character");
            return;
        }
        if (!char.activePet) {
             console.log("[PetHandler] spawnPet: No activePet");
             return;
        }
        if (!char.activePet.typeID) {
            console.log("[PetHandler] spawnPet: activePet.typeID is falsy");
            return;
        }

        const petDef = PetConfig.getPetDef(char.activePet.typeID);
        if (!petDef) {
            console.log(`[PetHandler] spawnPet: No definition for petID ${char.activePet.typeID}`);
            return;
        }

        console.log(`[PetHandler] Spawning pet ${petDef.PetName} (ID: ${char.activePet.typeID}) for ${char.name}`);

        // Create Entity for Pet
        // Use a large offset for pet ID to avoid collision
        const petEntID = client.clientEntID + 5000; 

        const entityProps: any = {
            id: petEntID,
            name: petDef.PetName, 
            isPlayer: false,
            x: char.CurrentLevel?.x || 0,
            y: char.CurrentLevel?.y || 0,
            v: 0,
            team: 1, // Player Team
            renderDepthOffset: 0,
            entState: 0,
            facingLeft: false,
            summonerId: client.clientEntID, // Linked to player
            characterName: char.name 
        };

        // Send to self
        const { EntityHandler } = require('./EntityHandler'); 
        EntityHandler.sendEntity(client, entityProps);
        
        console.log(`[PetHandler] Sent 0xF for pet entity ${petEntID} with summonerId ${client.clientEntID}`);

        // Broadcast
        const sessions = require('../core/GlobalState').GlobalState.sessionsByToken;
        for (const other of sessions.values()) {
            if (other !== client && areClientsInSameLevelScope(client, other)) {
                 EntityHandler.sendEntity(other, entityProps);
            }
        }
    }
}
