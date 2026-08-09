import { Client } from '../core/Client';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { normalizeCharacterKey } from '../core/SocialState';
import { getCraftTownHomeOwnerCharacter, isVisitingAnotherPlayersCraftTown } from '../utils/HomeVisitGuard';
import { EntityHandler } from './EntityHandler';
import { EquipmentHandler } from './EquipmentHandler';
import {
    buildHomeStatueEntity,
    buildHomeStatueSnapshot,
    getHomeStatueSlotByEntityId,
    HOME_STATUE_LEVEL,
    HomeStatueSlot,
    isHomeStatueEntityId,
    isSameHomeStatue,
    normalizeHomeStatueClass,
    readHomeStatues,
    seedHomeStatues,
    writeHomeStatues
} from '../core/HomeStatues';

/**
 * Keep garden statue interaction.
 *
 * Walking up to a statue and using it sends the stock TALK_TO_NPC packet (0x7A), because the client
 * sends that for every cued entity before it dispatches on the cue name - so the server hears about
 * the touch without a client patch. What the touch *means* is decided here:
 *
 *   - homeowner, standing in their own keep, playing the statue's class -> the statue is re-dressed
 *     with whatever that character is wearing right now.
 *   - anyone else -> nothing. The gear panel the visitor sees is opened locally by the client patch
 *     off the same click, so viewing needs no server round trip and cannot be used to edit.
 */
export class HomeStatueHandler {
    /** 0x44: single-line chat status text. */
    private static sendStatus(client: Client, text: string): void {
        const bb = new BitBuffer(false);
        bb.writeMethod13(text);
        client.sendBitBuffer(0x44, bb);
    }

    /**
     * Brings the statue line-up up to date, then spawns the host's statues for this session.
     *
     * Two things happen on the way in, and only in the player's own keep - a visitor must never
     * write to the host's save:
     *
     *   - every class on the account that has no statue yet gets one;
     *   - the statue of the class the player is *currently* on is re-cut from that character as they
     *     walk in. That is the "change your set, leave home, come back" loop: whatever you are
     *     wearing when you step into the keep is what your statue wears.
     */
    static onCraftTownSpawn(client: Client): void {
        if (client.currentLevel !== HOME_STATUE_LEVEL) {
            return;
        }

        if (client.character && !isVisitingAnotherPlayersCraftTown(client)) {
            const characters = HomeStatueHandler.accountCharacters(client);
            const book = readHomeStatues(client.character);
            let changed = seedHomeStatues(characters, book);

            const activeClass = normalizeHomeStatueClass(client.character.class);
            const snapshot = activeClass ? buildHomeStatueSnapshot(client.character) : null;
            if (activeClass && snapshot && !isSameHomeStatue(book[activeClass], snapshot)) {
                book[activeClass] = snapshot;
                changed = true;
            }

            if (changed) {
                writeHomeStatues(characters, book);
                HomeStatueHandler.persist(client, 'home statue sync');
            }
        }

        EntityHandler.sendHomeStatues(client);
    }

    /**
     * Returns true when the id was a statue, whether or not anything changed - the caller must then
     * skip the normal NPC dialogue path, since a statue has no dialogue.
     */
    static handleStatueInteract(client: Client, entityId: number): boolean {
        const slot = getHomeStatueSlotByEntityId(entityId);
        if (!slot) {
            return isHomeStatueEntityId(entityId);
        }

        if (!client.character || client.currentLevel !== HOME_STATUE_LEVEL) {
            return true;
        }

        if (isVisitingAnotherPlayersCraftTown(client)) {
            // Visitors already have the gear panel open on their own client; say why they cannot
            // change anything rather than staying silent.
            HomeStatueHandler.sendStatus(
                client,
                "This statue belongs to the homeowner. You can only view its gear."
            );
            return true;
        }

        const characterClass = normalizeHomeStatueClass(client.character.class);
        if (characterClass !== slot.characterClass) {
            HomeStatueHandler.sendStatus(
                client,
                `Only your ${slot.characterClass} character can change this statue.`
            );
            return true;
        }

        const snapshot = buildHomeStatueSnapshot(client.character);
        if (!snapshot) {
            return true;
        }

        const book = readHomeStatues(client.character);
        book[slot.characterClass] = snapshot;
        writeHomeStatues(HomeStatueHandler.accountCharacters(client), book);
        HomeStatueHandler.persist(client, 'home statue update');

        HomeStatueHandler.refreshStatue(client, slot);

        HomeStatueHandler.sendStatus(
            client,
            'Your statue now wears the set you have on.'
        );
        return true;
    }

    /** Whose keep this session is standing in, as a comparable key. */
    private static homeOwnerKey(client: Client): string {
        const owner = getCraftTownHomeOwnerCharacter(client.character, client.craftTownHostCharacter);
        return normalizeCharacterKey(owner?.name);
    }

    /**
     * Pushes the new look to the sessions that are actually looking at *this* keep's statues.
     *
     * The gate is the resolved keep owner, not the level scope. Statues carry fixed entity ids and
     * are per-session (see `EntityHandler.sendHomeStatues`), so broadcasting by scope alone would
     * hand another account's characters to anyone who happened to share the scope - the exact leak
     * this system must not have. Matching on the owner key means: yourself at home, plus anyone
     * visiting your keep, and nobody else.
     *
     * Sessions that already know the statue get a gear update (0xAF), the same packet another
     * player's gear change rides, so the statue re-dresses in place with no despawn flicker.
     */
    private static refreshStatue(client: Client, slot: HomeStatueSlot): void {
        const owner = getCraftTownHomeOwnerCharacter(client.character, client.craftTownHostCharacter);
        const snapshot = readHomeStatues(owner)[slot.characterClass];
        const ownerKey = HomeStatueHandler.homeOwnerKey(client);
        if (!snapshot || !ownerKey) {
            return;
        }

        const entityProps = buildHomeStatueEntity(slot, snapshot);
        const gearPayload = EquipmentHandler.buildEntityGearUpdatePacket(slot.entityId, snapshot.equippedGears);

        for (const session of GlobalState.sessionsByToken.values()) {
            if (
                !session.playerSpawned ||
                session.currentLevel !== HOME_STATUE_LEVEL ||
                HomeStatueHandler.homeOwnerKey(session) !== ownerKey
            ) {
                continue;
            }

            if (!session.knownEntityIds.has(slot.entityId)) {
                session.entities.set(slot.entityId, { ...entityProps });
                EntityHandler.sendEntity(session, entityProps);
                continue;
            }

            const known = session.entities.get(slot.entityId);
            if (known && typeof known === 'object') {
                known.equippedGears = entityProps.equippedGears;
            }
            session.send(0xAF, gearPayload);
        }
    }

    private static accountCharacters(client: Client): Array<any> {
        const characters: Array<any> = Array.isArray(client.characters) ? [...client.characters] : [];
        if (client.character && !characters.includes(client.character)) {
            characters.push(client.character);
        }
        return characters;
    }

    private static persist(client: Client, reason: string): void {
        if (!client.userId || !client.character) {
            return;
        }

        const index = client.characters.findIndex((entry) => entry?.name === client.character?.name);
        if (index >= 0) {
            client.characters[index] = client.character;
        } else {
            client.characters.push(client.character);
        }

        if (typeof client.scheduleCharacterSave === 'function') {
            client.scheduleCharacterSave(reason);
        }
    }
}
