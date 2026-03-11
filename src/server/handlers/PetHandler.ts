import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { JsonAdapter } from '../database/JsonAdapter';
import { PetConfig } from '../core/PetConfig';

const db = new JsonAdapter();

export class PetHandler {

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
                const chars = await db.loadCharacters(client.userId);
                const char = chars.find(c => c.name === client.character?.name);
                if (char) {
                    char.activePet = client.character.activePet;
                    char.restingPets = client.character.restingPets;
                    await db.saveCharacters(client.userId, chars);
                }
            }
        }
    }

    static async handleRequestHatcheryEggs(client: Client, data: Buffer): Promise<void> {
        if (!client.character) return;
        
        const now = Math.floor(Date.now() / 1000);
        let owned = client.character.OwnedEggsID || [];
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
                 await db.saveCharacters(client.userId, chars);
             }
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
        } else {
            if ((client.character.gold || 0) < goldCost) return;
            client.character.gold = (client.character.gold || 0) - goldCost;
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
        const owned = client.character.OwnedEggsID || [];
        if (slotIndex >= owned.length) return;

        const eggID = owned[slotIndex];
        const eggDef = PetConfig.getEggDef(eggID);
        if (!eggDef) return;

        const goldCost = PetConfig.EGG_GOLD_COST[slotIndex] || 0;
        const idolCost = PetConfig.EGG_IDOL_COST[slotIndex] || 0;

        if (useIdols) {
            if ((client.character.mammothIdols || 0) < idolCost) return;
            client.character.mammothIdols = (client.character.mammothIdols || 0) - idolCost;
        } else {
            if ((client.character.gold || 0) < goldCost) return;
            client.character.gold = (client.character.gold || 0) - goldCost;
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
        
        const bb = new BitBuffer();
        bb.writeMethod6(eggID, 6);
        client.sendBitBuffer(0xE7, bb);
    }
    
    static async handleEggSpeedUp(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const idolCost = br.readMethod9();
        
        if (!client.character) return;
        if ((client.character.mammothIdols || 0) < idolCost) return;
        
        client.character.mammothIdols = (client.character.mammothIdols || 0) - idolCost;
        
        if (client.character.EggHachery) {
            client.character.EggHachery.ReadyTime = 0;
            await PetHandler.saveCharacter(client);
            
             const bb = new BitBuffer();
             bb.writeMethod6(client.character.EggHachery.EggID, 6);
             client.sendBitBuffer(0xE7, bb);
        }
    }

    static async handleCollectHatchedEgg(client: Client, data: Buffer): Promise<void> {
        if (!client.character || !client.character.EggHachery) return;
        
        const eggData = client.character.EggHachery;
        const eggID = eggData.EggID;
        
        const petDef = PetConfig.getPetDef(eggID);
        if (!petDef) {
            console.log(`[PetHandler] No pet def for EggID ${eggID}`);
            return;
        }
        
        const petTypeID = petDef.PetID;
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
        
        const slotIndex = eggData.slotIndex;
        if (client.character.OwnedEggsID && typeof slotIndex === 'number') {
            client.character.OwnedEggsID.splice(slotIndex, 1);
        }
        
        client.character.EggHachery = {
            EggID: 0,
            ReadyTime: 0,
            slotIndex: 0
        };
        client.character.activeEggCount = 0;
        
        await PetHandler.saveCharacter(client);
        
        // 0x37 New Pet
        const bb = new BitBuffer();
        bb.writeMethod6(petTypeID, 7);
        bb.writeMethod4(specialID);
        bb.writeMethod6(startingRank, 6);
        bb.writeMethod15(false);
        client.sendBitBuffer(0x37, bb);
        
        // 0xE5 Refresh Hatchery
        const pkt = PetHandler.buildHatcheryPacket(client.character.OwnedEggsID || [], client.character.EggResetTime || 0);
        client.sendBitBuffer(0xE5, pkt);
    }

    static async handleCancelEggHatch(client: Client, data: Buffer): Promise<void> {
        if (!client.character) return;
        client.character.EggHachery = {
            EggID: 0,
            ReadyTime: 0,
            slotIndex: 0
        };
        client.character.activeEggCount = 0;
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
            if (other !== client && other.currentLevel === client.currentLevel) {
                 EntityHandler.sendEntity(other, entityProps);
            }
        }
    }
}
