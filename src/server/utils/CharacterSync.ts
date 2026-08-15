import { Client } from '../core/Client';
import { GlobalState } from '../core/GlobalState';
import { areClientsInSameLevelScope, getClientLevelScope } from '../core/LevelScope';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { WorldEnter } from './WorldEnter';
import { LegendsInn } from '../core/LegendsInn';
import { getAccountPrimaryCharacter } from '../core/SocialState';

export class CharacterSync {
    static sendPlayerDataRefresh(client: Client): void {
        if (!client.character || !client.currentLevel) {
            return;
        }

        const entity = client.clientEntID > 0 ? client.entities.get(client.clientEntID) : null;
        const x = Number(entity?.x ?? client.character.CurrentLevel?.x ?? 0);
        const y = Number(entity?.y ?? client.character.CurrentLevel?.y ?? 0);
        const hasCoord = Number.isFinite(x) && Number.isFinite(y);
        const levelName = String(client.currentLevel ?? client.character.CurrentLevel?.name ?? '');
        const payload = WorldEnter.buildPlayerDataPacket(
            client.character,
            Number(client.token ?? 0),
            0,
            // mBonusLevels has to be repeated on every refresh: this packet
            // replaces the client's copy wholesale, so sending 0 here would drop
            // every hostile in a Legends' Inn stage back to its authored level
            // in the middle of the run.
            LegendsInn.getMonsterBonusLevels(levelName),
            levelName,
            Math.round(hasCoord ? x : 0),
            Math.round(hasCoord ? y : 0),
            hasCoord,
            false,
            getAccountPrimaryCharacter(client.characters, client.character)
        );

        client.send(0x10, payload.toBuffer());
    }

    static sendActiveConsumableUpdate(client: Client, entityId: number, consumableId: number): void {
        if (entityId <= 0) {
            return;
        }

        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod6(Math.max(0, consumableId), 5);
        const payload = bb.toBuffer();

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || !areClientsInSameLevelScope(client, other)) {
                continue;
            }
            other.send(0x10D, payload);
        }
    }

    static requestCombatStatsRefresh(client: Client, statScale: number = 0): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(Math.max(0, Math.min(15, Math.round(statScale))), 4);
        bb.writeMethod4(Math.floor(Date.now() / 1000) & 0xffff);
        client.sendBitBuffer(0xFB, bb);
    }

    static updateLiveActiveConsumable(client: Client, consumableId: number): void {
        if (client.clientEntID <= 0) {
            return;
        }

        const normalized = Math.max(0, Math.round(Number(consumableId ?? 0)));
        const localEntity = client.entities.get(client.clientEntID);
        if (localEntity && typeof localEntity === 'object') {
            localEntity.activeConsumableId = normalized;
            localEntity.activeConsumableID = normalized;
        }

        const levelMap = GlobalState.levelEntities.get(getClientLevelScope(client));
        const levelEntity = levelMap?.get(client.clientEntID);
        if (levelEntity && typeof levelEntity === 'object') {
            levelEntity.activeConsumableId = normalized;
            levelEntity.activeConsumableID = normalized;
        }
    }
}
