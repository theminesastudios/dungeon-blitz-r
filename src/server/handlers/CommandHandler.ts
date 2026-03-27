import { Client } from '../core/Client';
import { DebugLogger } from '../core/Debug';
import { BitReader } from '../network/protocol/bitReader';

export class CommandHandler {
    static handleLinkUpdater(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        
        // Python:
        // client_elapsed = br.read_method_24()
        // client_desync  = br.read_method_15()
        // server_echo    = br.read_method_24()
        
        const clientElapsed = br.readMethod24();
        const clientDesync = br.readMethod15();
        const serverEcho = br.readMethod24();

        DebugLogger.logSync('LinkUpdater', client, {
            clientElapsed,
            clientDesync,
            serverEcho,
            currentRoomId: Number(client.currentRoomId ?? -1),
            knownEntityCount: client.knownEntityIds?.size ?? 0,
            localEntityCount: client.entities?.size ?? 0
        });
    }

    static handleQueuePotion(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        br.readMethod20(5);
    }
}
