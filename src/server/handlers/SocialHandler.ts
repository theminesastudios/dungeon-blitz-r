import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { GlobalState } from '../core/GlobalState';
import { JsonAdapter } from '../database/JsonAdapter';

const db = new JsonAdapter();

export class SocialHandler {
    private static forLevelRecipients(client: Client, includeSender: boolean = false): Client[] {
        const levelName = client.currentLevel;
        if (!levelName) {
            return [];
        }

        const recipients: Client[] = [];
        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || other.currentLevel !== levelName) {
                continue;
            }
            if (!includeSender && other === client) {
                continue;
            }
            recipients.push(other);
        }

        return recipients;
    }

    private static relayToLevel(client: Client, packetId: number, data: Buffer, includeSender: boolean = false): void {
        for (const other of SocialHandler.forLevelRecipients(client, includeSender)) {
            other.send(packetId, data);
        }
    }

    private static buildRoomThoughtPayload(entityId: number, text: string): Buffer {
        const bb = new BitBuffer();
        bb.writeMethod4(entityId);
        bb.writeMethod13(text);
        return bb.toBuffer();
    }

    // 0xF3: Request Visit Player House
    static async handleRequestVisitPlayerHouse(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const targetName = br.readMethod13();

        console.log(`[Social] ${client.character?.name} requesting to visit ${targetName}'s house.`);

        // 1. Resolve character data
        const targetId = await db.getAccountIdByCharName(targetName);
        if (!targetId) {
            // Send chat warning? 
            console.log(`[Social] Target ${targetName} not found.`);
            // TODO: Send chat status packet (0x81)
            return;
        }

        const chars = await db.loadCharacters(targetId);
        const targetChar = chars.find(c => c.name.toLowerCase() === targetName.toLowerCase());

        if (!targetChar) {
            console.log(`[Social] Character ${targetName} not found.`);
            return;
        }

        // 2. Store target char in GlobalState houseVisits for this session's clientEntID (token)
        // This persists across connection reset during 0x1D -> 0x21 handoff if using token match,
        // but here we are storing it by clientEntID which IS the token.
        // 2. Store target char in GlobalState houseVisits using client.token
        if (client.token) {
             GlobalState.houseVisits.set(client.token, targetChar);
             console.log(`[Social] Set house visit target for token ${client.token} to ${targetName}`);
        } else {
             console.error(`[Social] Client has no token! Cannot set house visit.`);
        }

        // 3. Trigger DO_TARGET (0x2E) for CraftTown (Door 999)
        // Client receives this and immediately sends 0x1D (Level Transfer) for "CraftTown"
        // In 0x1D handler, we will see the override in houseVisits.

        const bb = new BitBuffer();
        bb.writeMethod4(999); // Door ID 999 -> CraftTown logic
        bb.writeMethod13("CraftTown");
        client.lastDoorId = 999;
        client.lastDoorTargetLevel = "CraftTown";

        const payload = bb.toBuffer(); // Check BitBuffer implementation if it has toBuffer() or similar
        // BitBuffer usually has `buf` or `buffer` property, or `getBuffer()`?
        // Checking BitBuffer.ts... standard implementation usually `toBuffer()`
        // Using `client.sendBitBuffer` handles wrapping.

        client.sendBitBuffer(0x2E, bb);
    }

    static handleRoomThought(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const entityId = br.readMethod4();
        const text = br.readMethod13();
        const payload = SocialHandler.buildRoomThoughtPayload(entityId, text);

        SocialHandler.relayToLevel(client, 0x76, payload, true);
    }

    static handleStartSkit(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const entityId = br.readMethod9();
        br.readMethod15(); // Whether the client also wants chat text; unused by Python too.
        const text = br.readMethod26();
        const payload = SocialHandler.buildRoomThoughtPayload(entityId, text);

        // Python translates skits into room-thought packets for everyone in the level.
        SocialHandler.relayToLevel(client, 0x76, payload, true);
    }

    static handleEmoteBegin(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        br.readMethod4();
        br.readMethod13();

        SocialHandler.relayToLevel(client, 0x7E, data);
    }

    static handleEmote(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        br.readMethod9();
        br.readMethod26();
        br.readMethod26();
        br.readMethod15();

        SocialHandler.relayToLevel(client, 0xA7, data);
    }

    static handleLevelState(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        br.readMethod26();
        br.readMethod26();

        SocialHandler.relayToLevel(client, 0x40, data);
    }

    static handleEmoteEnd(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        br.readMethod4();

        SocialHandler.relayToLevel(client, 0x7F, data);
    }
}
