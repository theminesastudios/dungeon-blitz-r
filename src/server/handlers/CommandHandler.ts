import { Client } from '../core/Client';
import { JsonAdapter } from '../database/JsonAdapter';
import { BitReader } from '../network/protocol/bitReader';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { CharacterSync } from '../utils/CharacterSync';
import {
    ensureActiveDungeonPotionReserved,
    getActivePotionCharges,
    getStoredConsumableCount,
    hasAvailablePotionSelection,
    isPotionConsumable,
    sendConsumableUpdate
} from '../utils/ConsumableState';

const db = new JsonAdapter();
const POTION_CHARGE_UNIT_MS = 60;
const POTION_DRAIN_STEP_UNITS = 50;
const POTION_DRAIN_STEP_MS = POTION_CHARGE_UNIT_MS * POTION_DRAIN_STEP_UNITS;

export class CommandHandler {
    static async handleLinkUpdater(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        
        // Python:
        // client_elapsed = br.read_method_24()
        // client_desync  = br.read_method_15()
        // server_echo    = br.read_method_24()
        
        const clientElapsed = br.readMethod24();
        const clientDesync = br.readMethod15();
        const serverEcho = br.readMethod24();

        // Used for heartbeat / sync
        // Python implementation effectively does nothing but parse and maybe log desync.
        // We'll just log deeply verbose if needed, otherwise ignore to avoid spam.
        // console.log(`[LinkUpdater] Sync: elapsed=${clientElapsed}, desync=${clientDesync}, echo=${serverEcho}`);
        await CommandHandler.syncDungeonPotionCharge(client);
    }

    static async handleQueuePotion(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const queuedConsumableId = br.readMethod20(5);
        if (!CommandHandler.isValidPotionSelection(client, queuedConsumableId)) {
            return;
        }

        client.character.queuedConsumableID = queuedConsumableId;
        await CommandHandler.saveCharacter(client);
    }

    static async handleActivatePotion(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const entityId = br.readMethod9();
        const activeConsumableId = br.readMethod20(5);
        const previousActiveConsumableId = Math.max(0, Math.round(Number(client.character.activeConsumableID ?? 0)));
        if (entityId <= 0 || (client.clientEntID > 0 && entityId !== client.clientEntID)) {
            return;
        }

        if (!CommandHandler.isValidPotionSelection(client, activeConsumableId)) {
            return;
        }

        if (activeConsumableId !== previousActiveConsumableId) {
            client.character.activeConsumableCharges = 0;
        }
        client.character.activeConsumableID = activeConsumableId;
        if (activeConsumableId === 0) {
            client.character.queuedConsumableID = 0;
            client.character.activeConsumableCharges = 0;
            client.activePotionDrainAtMs = 0;
        } else if (ensureActiveDungeonPotionReserved(client.character, client.currentLevel, activeConsumableId)) {
            client.activePotionDrainAtMs = Date.now();
            sendConsumableUpdate(client, activeConsumableId);
        } else {
            client.activePotionDrainAtMs = LevelConfig.isDungeonLevel(client.currentLevel) ? Date.now() : 0;
        }

        CharacterSync.updateLiveActiveConsumable(client, activeConsumableId);
        CharacterSync.sendActiveConsumableUpdate(client, entityId || client.clientEntID, activeConsumableId);
        CharacterSync.requestCombatStatsRefresh(client);
        await CommandHandler.saveCharacter(client);
    }

    static handleHpIncreaseNotice(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const maxHpDelta = Math.round(br.readMethod24());
        const currentMaxHp = Math.max(1, Number(client.authoritativeMaxHp ?? 100));
        const newMaxHp = Math.max(1, currentMaxHp + maxHpDelta);

        client.authoritativeMaxHp = newMaxHp;
        client.authoritativeCurrentHp = Math.min(Math.max(0, Number(client.authoritativeCurrentHp ?? newMaxHp)), newMaxHp);

        const entity = client.clientEntID > 0 ? client.entities.get(client.clientEntID) : null;
        if (entity && typeof entity === 'object') {
            entity.maxHp = newMaxHp;
            entity.hp = Math.min(Math.max(0, Number(entity.hp ?? newMaxHp)), newMaxHp);
        }
    }

    static handleSendCombatStats(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const meleeDamage = br.readMethod9();
        const magicDamage = br.readMethod9();
        const maxHp = Math.max(1, br.readMethod9());
        br.readMethod20(4);
        br.readMethod9();

        client.authoritativeMaxHp = maxHp;
        client.authoritativeCurrentHp = Math.min(Math.max(0, Number(client.authoritativeCurrentHp ?? maxHp)), maxHp);

        const entity = client.clientEntID > 0 ? client.entities.get(client.clientEntID) : null;
        if (entity && typeof entity === 'object') {
            entity.maxHp = maxHp;
            entity.hp = Math.min(Math.max(0, Number(entity.hp ?? maxHp)), maxHp);
            entity.meleeDamage = meleeDamage;
            entity.magicDamage = magicDamage;
        }

    }

    private static isValidPotionSelection(client: Client, consumableId: number): boolean {
        if (!client.character) {
            return false;
        }

        if (consumableId === 0) {
            return true;
        }

        const consumable = GameData.CONSUMABLES.find((entry) => Number(entry?.ConsumableID ?? 0) === consumableId);
        if (!consumable) {
            return false;
        }

        const type = String(consumable.Type ?? '');
        if (type !== 'Potion' && type !== 'ResPotion') {
            return false;
        }

        return hasAvailablePotionSelection(client.character, consumableId);
    }

    private static async syncDungeonPotionCharge(client: Client): Promise<void> {
        if (!client.character) {
            client.activePotionDrainAtMs = 0;
            return;
        }

        const activeConsumableId = Math.max(0, Math.round(Number(client.character.activeConsumableID ?? 0)));
        if (!LevelConfig.isDungeonLevel(client.currentLevel) || !isPotionConsumable(activeConsumableId)) {
            client.activePotionDrainAtMs = 0;
            return;
        }

        const nowMs = Date.now();
        let didChange = false;
        if (ensureActiveDungeonPotionReserved(client.character, client.currentLevel, activeConsumableId)) {
            didChange = true;
        }

        let activeCharges = getActivePotionCharges(client.character);
        if (activeCharges <= 0) {
            client.activePotionDrainAtMs = nowMs;
            if (didChange) {
                sendConsumableUpdate(client, activeConsumableId);
            }
            return;
        }

        if (client.activePotionDrainAtMs <= 0) {
            client.activePotionDrainAtMs = nowMs;
            if (didChange) {
                sendConsumableUpdate(client, activeConsumableId);
            }
            return;
        }

        const elapsedMs = Math.max(0, nowMs - client.activePotionDrainAtMs);
        const initialDrainSteps = Math.floor(elapsedMs / POTION_DRAIN_STEP_MS);
        const initialDrainUnits = initialDrainSteps * POTION_DRAIN_STEP_UNITS;
        if (initialDrainUnits <= 0) {
            if (didChange) {
                sendConsumableUpdate(client, activeConsumableId);
            }
            return;
        }

        let remainingDrainUnits = initialDrainUnits;
        while (remainingDrainUnits > 0) {
            activeCharges = getActivePotionCharges(client.character);
            if (activeCharges <= 0) {
                if (!ensureActiveDungeonPotionReserved(client.character, client.currentLevel, activeConsumableId)) {
                    break;
                }
                didChange = true;
                activeCharges = getActivePotionCharges(client.character);
                if (activeCharges <= 0) {
                    break;
                }
            }

            const drainedUnits = Math.min(activeCharges, remainingDrainUnits);
            client.character.activeConsumableCharges = activeCharges - drainedUnits;
            remainingDrainUnits -= drainedUnits;
            didChange = didChange || drainedUnits > 0;

            if (
                client.character.activeConsumableCharges <= 0 &&
                getStoredConsumableCount(client.character, activeConsumableId) <= 0
            ) {
                break;
            }
        }

        const consumedDrainUnits = initialDrainUnits - remainingDrainUnits;
        client.activePotionDrainAtMs += Math.floor(consumedDrainUnits / POTION_DRAIN_STEP_UNITS) * POTION_DRAIN_STEP_MS;

        if (didChange) {
            sendConsumableUpdate(client, activeConsumableId);
        }
    }

    private static async saveCharacter(client: Client): Promise<void> {
        if (!client.userId || !client.character) {
            return;
        }

        const index = client.characters.findIndex((character) => character.name === client.character?.name);
        if (index >= 0) {
            client.characters[index] = client.character;
        } else {
            client.characters.push(client.character);
        }

        await db.saveCharacters(client.userId, client.characters);
    }
}
