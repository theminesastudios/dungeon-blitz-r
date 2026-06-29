import { Client } from '../core/Client';
import { GameData } from '../core/GameData';
import { PetConfig } from '../core/PetConfig';
import { JsonAdapter } from '../database/JsonAdapter';
import { WalletService } from '../database/WalletService';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

const db = new JsonAdapter();

type SigilStoreItemType = 'mount' | 'pet' | 'consumable' | 'respec_stone' | 'charm_remover';

interface SigilStoreItem {
    name: string;
    type: SigilStoreItemType;
    cost_sigils: number;
    quantity: number;
    cost_gold?: number;
}

export class SigilHandler {
    private static readonly STORE_ITEMS: Record<number, SigilStoreItem> = {
        1: { name: 'MountLockbox01L02', type: 'mount', cost_sigils: 3200, quantity: 1 },
        2: { name: 'MountLockbox01R01', type: 'mount', cost_sigils: 640, quantity: 1 },
        3: { name: 'Lockbox01L02', type: 'pet', cost_sigils: 2400, quantity: 1 },
        4: { name: 'Lockbox01RRed', type: 'pet', cost_sigils: 320, quantity: 1 },
        5: { name: 'Lockbox01RYellow', type: 'pet', cost_sigils: 320, quantity: 1 },
        6: { name: 'Lockbox01RBlue', type: 'pet', cost_sigils: 320, quantity: 1 },
        7: { name: 'Lockbox01RGreen', type: 'pet', cost_sigils: 320, quantity: 1 },
        8: { name: 'RespecStone', type: 'respec_stone', cost_sigils: 320, quantity: 1 },
        9: { name: 'XPFindRegular', type: 'consumable', cost_sigils: 16, quantity: 3 },
        10: { name: 'MaterialFindRegular', type: 'consumable', cost_sigils: 16, quantity: 3 },
        11: { name: 'GoldFindRegular', type: 'consumable', cost_sigils: 16, quantity: 3 },
        12: { name: 'GearFindRegular', type: 'consumable', cost_sigils: 16, quantity: 3 },
        13: { name: 'Resurrection', type: 'consumable', cost_sigils: 32, quantity: 5 },
        14: { name: 'ForgeXP', type: 'consumable', cost_sigils: 112, quantity: 1 },
        15: { name: 'CharmRemover', type: 'charm_remover', cost_sigils: 80, quantity: 1 }
    };

    static async handleRoyalSigilStorePurchase(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const itemId = br.readMethod20(5);
        const item = SigilHandler.STORE_ITEMS[itemId];

        if (!item) {
            console.log(`[SigilHandler] Unknown item ID ${itemId}`);
            return;
        }

        const costSigils = Number(item.cost_sigils ?? 0);
        const costGold = Number(item.cost_gold ?? 0);

        const didSpendWallet = await WalletService.applyDelta(client, {
            SilverSigils: -costSigils,
            gold: -costGold
        });
        if (!didSpendWallet) {
            console.log(`[SigilHandler] Not enough wallet balance for item ${itemId}`);
            return;
        }

        if (costSigils > 0) {
            SigilHandler.sendSigilDecrease(client, costSigils);
        }

        if (costGold > 0) {
            SigilHandler.sendGoldLoss(client, costGold);
        }

        switch (item.type) {
            case 'mount':
                SigilHandler.grantMount(client, item.name);
                break;
            case 'pet':
                SigilHandler.grantPet(client, item.name);
                break;
            case 'consumable':
                SigilHandler.grantConsumable(client, item.name, item.quantity);
                break;
            case 'respec_stone':
            case 'charm_remover':
                SigilHandler.grantCharm(client, item.name, item.quantity);
                break;
            default:
                break;
        }

        await SigilHandler.saveCharacter(client);
    }

    private static grantMount(client: Client, mountName: string): void {
        const character = client.character;
        if (!character) {
            return;
        }

        const mountId = GameData.getMountId(mountName);
        if (mountId <= 0) {
            console.log(`[SigilHandler] Unknown mount name ${mountName}`);
            return;
        }

        if (!Array.isArray(character.mounts)) {
            character.mounts = [];
        }

        if (!character.mounts.includes(mountId)) {
            character.mounts.push(mountId);
            SigilHandler.sendMountReward(client, mountId, false);
        }
    }

    private static grantPet(client: Client, petName: string): void {
        const character = client.character;
        if (!character) {
            return;
        }

        const petDef = PetConfig.PET_TYPES.find((pet) => String(pet?.PetName ?? '') === petName);
        if (!petDef) {
            console.log(`[SigilHandler] Unknown pet name ${petName}`);
            return;
        }

        const pets = Array.isArray(character.pets) ? character.pets : [];
        const nextSpecialId = pets.reduce((max: number, pet: any) => {
            return Math.max(max, Number(pet?.special_id ?? 0));
        }, 0) + 1;

        const newPet = {
            typeID: Number(petDef.PetID),
            special_id: nextSpecialId,
            level: 1,
            xp: 0
        };

        pets.push(newPet);
        character.pets = pets;
        SigilHandler.sendNewPetReward(client, newPet.typeID, newPet.special_id, newPet.level, false);
    }

    private static grantConsumable(client: Client, consumableName: string, quantity: number): void {
        const character = client.character;
        if (!character) {
            return;
        }

        const consumableId = GameData.getConsumableId(consumableName);
        if (consumableId <= 0) {
            console.log(`[SigilHandler] Unknown consumable name ${consumableName}`);
            return;
        }

        if (!Array.isArray(character.consumables)) {
            character.consumables = [];
        }

        const entry = character.consumables.find((consumable: any) => Number(consumable?.consumableID ?? 0) === consumableId);
        const newTotal = entry ? Number(entry.count ?? 0) + quantity : quantity;

        if (entry) {
            entry.count = newTotal;
        } else {
            character.consumables.push({ consumableID: consumableId, count: quantity });
        }

        SigilHandler.sendConsumableReward(client, consumableId, quantity, newTotal);
    }

    private static grantCharm(client: Client, charmName: string, quantity: number): void {
        const character = client.character;
        if (!character) {
            return;
        }

        const charmId = GameData.getCharmId(charmName);
        if (charmId <= 0) {
            console.log(`[SigilHandler] Unknown charm name ${charmName}`);
            return;
        }

        if (!Array.isArray(character.charms)) {
            character.charms = [];
        }

        const entry = character.charms.find((charm: any) => Number(charm?.charmID ?? 0) === charmId);
        if (entry) {
            entry.count = Number(entry.count ?? 0) + quantity;
        } else {
            character.charms.push({ charmID: charmId, count: quantity });
        }

        SigilHandler.sendCharmReward(client, charmId, false);
    }

    private static sendSigilDecrease(client: Client, amount: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(amount);
        client.sendBitBuffer(0x10F, bb);
    }

    private static sendGoldLoss(client: Client, amount: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(amount);
        client.sendBitBuffer(0xB4, bb);
    }

    private static sendMountReward(client: Client, mountId: number, suppress: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(mountId);
        bb.writeMethod15(suppress);
        client.sendBitBuffer(0x36, bb);
    }

    private static sendNewPetReward(client: Client, petTypeId: number, specialId: number, level: number, suppress: boolean): void {
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

    private static sendCharmReward(client: Client, charmId: number, suppress: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(charmId, 16);
        bb.writeMethod15(suppress);
        client.sendBitBuffer(0x109, bb);
    }

    private static async saveCharacter(client: Client): Promise<void> {
        if (!client.userId || !client.character) {
            return;
        }

        const characters = await db.loadCharacters(client.userId);
        const index = characters.findIndex((character) => character.name === client.character?.name);

        if (index >= 0) {
            characters[index] = client.character;
        } else {
            characters.push(client.character);
        }

        client.characters = characters;
        await db.saveCharacters(client.userId, characters);
    }
}
