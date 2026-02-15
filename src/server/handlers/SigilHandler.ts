import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { JsonAdapter } from '../database/JsonAdapter';
import { GameData } from '../core/GameData';
import { PetConfig } from '../core/PetConfig';

const db = new JsonAdapter();

export class SigilHandler {

    // Store items logical mapping
    private static readonly STORE_ITEMS: { [key: number]: any } = {
         1: {"name": "MountLockbox01L02", "type": "mount", "cost_sigils": 3200, "quantity": 1},
         2: {"name": "MountLockbox01R01", "type": "mount", "cost_sigils": 640, "quantity": 1},
         3: {"name": "Lockbox01L02", "type": "pet", "cost_sigils": 2400, "quantity": 1},
         4: {"name": "Lockbox01RRed", "type": "pet", "cost_sigils": 320, "quantity": 1},
         5: {"name": "Lockbox01RYellow", "type": "pet", "cost_sigils": 320, "quantity": 1},
         6: {"name": "Lockbox01RBlue", "type": "pet", "cost_sigils": 320, "quantity": 1},
         7: {"name": "Lockbox01RGreen", "type": "pet", "cost_sigils": 320, "quantity": 1},
         8: {"name": "RespecStone", "type": "respec_stone", "cost_sigils": 320, "quantity": 1},
         9: {"name": "XPFindRegular", "type": "consumable", "cost_sigils": 16, "quantity": 3},
        10: {"name": "MaterialFindRegular", "type": "consumable", "cost_sigils": 16, "quantity": 3},
        11: {"name": "GoldFindRegular", "type": "consumable", "cost_sigils": 16, "quantity": 3},
        12: {"name": "GearFindRegular", "type": "consumable", "cost_sigils": 16, "quantity": 3},
        13: {"name": "Resurrection", "type": "consumable", "cost_sigils": 32, "quantity": 5},
        14: {"name": "ForgeXP", "type": "consumable", "cost_sigils": 112, "quantity": 1},
        15: {"name": "CharmRemover", "type": "charm_remover", "cost_sigils": 80, "quantity": 1}
    };

    static async handleRoyalSigilStorePurchase(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const itemId = br.readMethod20(5);
        
        console.log(`[SigilHandler] Purchase request item_id=${itemId}`);
        
        if (!client.character) return;
        
        const item = SigilHandler.STORE_ITEMS[itemId];
        if (!item) {
            console.log(`[SigilHandler] Unknown item ID ${itemId}`);
            return;
        }
        
        const costSigils = item.cost_sigils || 0;
        const currentSigils = client.character.SilverSigils || 0;
        
        if (currentSigils < costSigils) {
            console.log(`[SigilHandler] Not enough sigils. Need ${costSigils}, have ${currentSigils}`);
            return;
        }
        
        client.character.SilverSigils = currentSigils - costSigils;
        
        // Send sigil decrease 0x10F
        SigilHandler.sendSigilDecrease(client, costSigils);
        
        // Save handled at end
        
        const type = item.type;
        const name = item.name;
        const quantity = item.quantity || 1;
        
        if (type === 'mount') {
            const mountId = GameData.getMountId(name);
            if (mountId > 0) {
                if (!client.character.mounts) client.character.mounts = [];
                if (!client.character.mounts.includes(mountId)) {
                    client.character.mounts.push(mountId);
                    SigilHandler.sendMountReward(client, mountId, false);
                }
            }
        } else if (type === 'pet') {
            const petDef = PetConfig.PET_TYPES.find(p => p.PetName === name || p.PetID === name); // name match might be ID string
            // Actually config usually has PetName. 
            // In python: p.get("PetName") == item_name or p.get("PetID") == item_name
            // item.name like "Lockbox01L02" might not be PetName?
            // Ah, store_items map in python maps ID to name "Lockbox...".
            // But getPetDef(item_name) is called? 
            // Wait, python logic:
            // pet_def = next((p for p in PET_TYPES if p.get("PetName") == item_name or p.get("PetID") == item_name), None)
            
            // "Lockbox01L02" is likely NOT a pet Name. It's an internal name.
            // Maybe pet_types.json has PetID matching this string?
            // Or maybe I should assume GameData needs to map Lockbox name to Pet?
            // Python code implies PET_TYPES have this name.
            
            if (petDef) {
                const typeId = petDef.PetID;
                const pets = client.character.pets || [];
                const maxSpecial = pets.reduce((max: number, p: any) => Math.max(max, p.special_id || 0), 0);
                const specialId = maxSpecial + 1;
                
                pets.push({
                    typeID: typeId,
                    special_id: specialId,
                    level: 1,
                    xp: 0
                });
                client.character.pets = pets;
                
                // Send 0x37
                const bb = new BitBuffer();
                bb.writeMethod6(typeId, 7);
                bb.writeMethod4(specialId);
                bb.writeMethod6(1, 6);
                bb.writeMethod15(false);
                client.sendBitBuffer(0x37, bb);
            }
        } else if (type === 'consumable' || type === 'respec_stone' || type === 'charm_remover') {
            // Treat all as consumable?
            // Respec/CharmRemover might be charmlike or consumablelike.
            // Python: "consumable" -> 0x10C update, 0x10B reward
            // "respec_stone" -> 0x109 (Charm Reward)
            // "charm_remover" -> 0x109 (Charm Reward)
            
            // Wait, python explicitly splits them.
            // Consumable uses get_consumable_id
            // Respec/Remover uses get_charm_id
            
            if (type === 'consumable') {
                const cId = GameData.getConsumableId(name);
                if (cId > 0) {
                    if (!client.character.consumables) client.character.consumables = [];
                    const entry = client.character.consumables.find((c: any) => c.consumableID === cId);
                    let newTotal = quantity;
                    if (entry) {
                        entry.count = (entry.count || 0) + quantity;
                        newTotal = entry.count;
                    } else {
                        client.character.consumables.push({ consumableID: cId, count: quantity });
                    }
                    
                    SigilHandler.sendConsumableReward(client, cId, quantity, newTotal, name);
                }
            } else {
                // Charm based
                const cId = GameData.getCharmId(name);
                if (cId > 0) {
                     if (!client.character.charms) client.character.charms = [];
                     const entry = client.character.charms.find((c: any) => c.charmID === cId);
                     if (entry) {
                         entry.count = (entry.count || 0) + quantity;
                     } else {
                         client.character.charms.push({ charmID: cId, count: quantity });
                     }
                     SigilHandler.sendCharmReward(client, cId, name);
                }
            }
        }

        await SigilHandler.saveCharacter(client);
    }
    
    private static sendSigilDecrease(client: Client, amount: number) {
        const bb = new BitBuffer();
        bb.writeMethod4(amount);
        client.sendBitBuffer(0x10F, bb);
    }
    
    private static sendMountReward(client: Client, mountId: number, suppress: boolean) {
        const bb = new BitBuffer();
        bb.writeMethod4(mountId);
        bb.writeMethod15(suppress);
        client.sendBitBuffer(0x36, bb);
    }
    
    private static sendConsumableReward(client: Client, id: number, quantity: number, total: number, name: string) {
        // 0x10C Update
        const bb1 = new BitBuffer();
        bb1.writeMethod6(id, 5);
        bb1.writeMethod4(total);
        client.sendBitBuffer(0x10C, bb1);
        
        // 0x10B Reward
        // Check if potion (multiply by 5000?)
        // GameData should tell us type.
        // For now assume standard quantity.
        // Python: if type == "Potion" display_amount = amount * 5000
        
        // We'd need to look up type in GameData.CONSUMABLES
        const def = GameData.CONSUMABLES.find(c => c.ConsumableID == id); // loose compare
        let displayQty = quantity;
        if (def && def.Type === "Potion") {
             displayQty = quantity * 5000;
        }

        const bb2 = new BitBuffer();
        bb2.writeMethod6(id, 5);
        bb2.writeMethod4(displayQty);
        bb2.writeMethod15(false);
        client.sendBitBuffer(0x10B, bb2);
    }
    
    private static sendCharmReward(client: Client, id: number, name: string) {
        const bb = new BitBuffer();
        bb.writeMethod6(id, 16);
        bb.writeMethod15(false);
        client.sendBitBuffer(0x109, bb);
    }
    
    private static async saveCharacter(client: Client) {
        if (client.userId && client.character) {
             const chars = await db.loadCharacters(client.userId);
             const idx = chars.findIndex(c => c.name === client.character?.name);
             if (idx !== -1) {
                 chars[idx] = client.character;
                 await db.saveCharacters(client.userId, chars);
             }
        }
    }
}
