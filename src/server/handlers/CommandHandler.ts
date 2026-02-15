import { Client } from '../core/Client';
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

        // Used for heartbeat / sync
        // Python implementation effectively does nothing but parse and maybe log desync.
        // We'll just log deeply verbose if needed, otherwise ignore to avoid spam.
        // console.log(`[LinkUpdater] Sync: elapsed=${clientElapsed}, desync=${clientDesync}, echo=${serverEcho}`);
    }
}
