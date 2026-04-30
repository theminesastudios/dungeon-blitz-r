import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { JsonAdapter } from '../database/JsonAdapter';
import { PetConfig } from '../core/PetConfig';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { EntityHandler } from './EntityHandler';
import { areClientsInSameLevelScope, getClientLevelScope } from '../core/LevelScope';

const db = new JsonAdapter();

export class PetHandler {
    private static readonly MOUNT_REASSERT_DELAYS_MS = [0, 300, 1200, 2500, 4000];
    private static readonly PET_ACTIVE_BONUS_BASE_RATE = 0.09;
    private static readonly PET_BONUS_RATE_PER_LEVEL = 0.01;

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

    private static sendPetXpUpdate(client: Client, xpAmount: number): void {
        if (xpAmount <= 0) {
            return;
        }

        const bb = new BitBuffer(false);
        bb.writeMethod4(xpAmount);
        client.sendBitBuffer(0xF2, bb);
    }

    static getActivePetRecord(character: any): any | null {
        if (!character) {
            return null;
        }

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

    static getActivePetBonusRates(character: any): { goldFind: number; itemFind: number; craftFind: number; expBonus: number } {
        const bonuses = {
            goldFind: 0,
            itemFind: 0,
            craftFind: 0,
            expBonus: 0
        };
        const pet = PetHandler.getActivePetRecord(character);
        if (!pet) {
            return bonuses;
        }

        const petDef = PetConfig.getPetDef(Number(pet.typeID ?? 0));
        if (!petDef) {
            return bonuses;
        }

        const petLevel = Math.max(0, Number(pet.level ?? 1));
        const bonus = petLevel > 0
            ? PetHandler.PET_ACTIVE_BONUS_BASE_RATE + petLevel * PetHandler.PET_BONUS_RATE_PER_LEVEL
            : 0;

        if (petDef.GoldFind) bonuses.goldFind += bonus;
        if (petDef.ItemFind) bonuses.itemFind += bonus;
        if (petDef.CraftFind) bonuses.craftFind += bonus;
        if (petDef.ExpBonus) bonuses.expBonus += bonus;

        return bonuses;
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
        
        const now = Math.floor(Date.now() / 1000);
        let owned = PetHandler.normalizeOwnedEggIds(client.character);
        let resetTime = client.character.EggResetTime || 0;

        if (now >= resetTime) {
            const maxSlots = PetConfig.MAX_EGG_SLOTS;
            const openSlots = maxSlots - owned.length;
            
            if (openSlots > 0) {
                const newCount = Math.min(openSlots, 3);
                const addedEggs = PetHandler.pickDailyEggs(newCount);
                owned = owned.concat(addedEggs);
                console.log(`[PetHandler] Added eggs: ${addedEggs}`);
            }

            resetTime = now + PetConfig.NEW_EGG_SET_TIME;
            client.character.EggResetTime = resetTime;
            client.character.OwnedEggsID = owned;
            
            if (client.userId) {
                await PetHandler.saveCharacter(client);
            }
        }

        client.character.EggNotifySent = false;
        
        const pkt = PetHandler.buildHatcheryPacket(owned, resetTime);
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
        const validEggs = PetConfig.EGG_TYPES.filter(e => e.EggID > 0);
        const chosen: number[] = [];
        for (let i = 0; i < count; i++) {
            if (validEggs.length > 0) {
                const idx = Math.floor(Math.random() * validEggs.length);
                chosen.push(validEggs[idx].EggID);
            }
        }
        return chosen;
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

    private static normalizeOwnedEggIds(character: any): number[] {
        const eggs = Array.isArray(character?.OwnedEggsID) ? character.OwnedEggsID : [];
        const normalized = eggs
            .map((eggId: unknown) => Number(eggId ?? 0))
            .filter((eggId: number) => Number.isFinite(eggId) && eggId >= 0);

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

    static async handleTrainPet(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const typeID = br.readMethod6(7);
        const uniqueID = br.readMethod9();
        const nextRank = br.readMethod6(6);
        const useIdols = br.readMethod15();

        if (!client.character) return;
        
        const trainTime = PetConfig.TRAINING_TIME[nextRank] || 0;
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

        const readyAt = Math.floor(Date.now() / 1000) + trainTime;
        
        client.character.trainingPet = [{
            typeID: typeID,
            special_id: uniqueID,
            trainingTime: readyAt
        }];

        await PetHandler.saveCharacter(client);
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
        
        client.character.trainingPet = [{
            typeID: 0,
            special_id: 0,
            trainingTime: 0
        }];

        await PetHandler.saveCharacter(client);
        
        // Notify client if needed? Python handle_pet_training_collect doesn't send packet back immediately, 
        // just saves.
    }

    static async handlePetTrainingCancel(client: Client, data: Buffer): Promise<void> {
        if (!client.character) return;
        client.character.trainingPet = [{
            typeID: 0,
            special_id: 0,
            trainingTime: 0
        }];
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
            
            const bb = new BitBuffer();
            bb.writeMethod6(petType, 7);
            bb.writeMethod4(Math.floor(Date.now()/1000));
            client.sendBitBuffer(0xEE, bb);
        }
    }

    static async handleEggHatch(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const slotIndex = br.readMethod20(4);
        const useIdols = br.readMethod15();

        if (!client.character) return;
        const owned = PetHandler.normalizeOwnedEggIds(client.character);
        if (slotIndex < 0 || slotIndex >= owned.length) return;

        const eggID = Number(owned[slotIndex] ?? 0);
        const eggDef = PetConfig.getEggDef(eggID);
        if (!eggDef) return;

        const goldCost = PetConfig.EGG_GOLD_COST[slotIndex] || 0;
        const idolCost = PetConfig.EGG_IDOL_COST[slotIndex] || 0;

        if (useIdols) {
            if ((client.character.mammothIdols || 0) < idolCost) return;
            client.character.mammothIdols = (client.character.mammothIdols || 0) - idolCost;
            PetHandler.sendMammothIdolUpdate(client);
        } else {
            if ((client.character.gold || 0) < goldCost) return;
            client.character.gold = (client.character.gold || 0) - goldCost;
            PetHandler.sendGoldLoss(client, goldCost);
        }

        const eggRank = eggDef.EggRank || 0;
        const hasPets = (client.character.pets && client.character.pets.length > 0);
        let duration = 0;
        
        if (!hasPets) {
            duration = 180;
        } else {
            duration = PetConfig.EGG_HATCH_TIMES[eggRank as 0|1|2] || 864000;
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
    }
    
    static async handleEggSpeedUp(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const idolCost = br.readMethod9();
        
        if (!client.character) return;
        if ((client.character.mammothIdols || 0) < idolCost) return;
        
        client.character.mammothIdols = (client.character.mammothIdols || 0) - idolCost;
        PetHandler.sendMammothIdolUpdate(client);
        
        const eggData = PetHandler.getNormalizedEggHatchery(client.character);
        if (eggData && eggData.EggID > 0) {
            eggData.ReadyTime = 0;
            client.character.EggHachery = eggData;
            await PetHandler.saveCharacter(client);
            
            const bb = new BitBuffer();
            bb.writeMethod6(eggData.EggID, 6);
            client.sendBitBuffer(0xE7, bb);
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
        
        const petDef = PetConfig.resolveRandomPetForEgg(eggID);
        if (!petDef) {
            console.log(`[PetHandler] No hatchable pet found for EggID ${eggID}`);
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
        
        const slotIndex = Number(eggData.slotIndex ?? 0);
        const ownedEggs = PetHandler.normalizeOwnedEggIds(client.character);
        if (slotIndex >= 0 && slotIndex < ownedEggs.length) {
            ownedEggs.splice(slotIndex, 1);
        }
        client.character.OwnedEggsID = ownedEggs;
        PetHandler.resetEggHatchery(client.character);
        
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
