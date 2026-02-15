
import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';

export class SystemHandler {
    // 0x7C: Client Crash Report
    // Python: _, length = struct.unpack_from(">HH", data, 0); payload = data[4:4 + length]
    static handleClientCrashReport(client: Client, data: Buffer): void {
        try {
            // data is payload only if from router? 
            // Router passes payload.
            // But python logic unpacks length from header? 
            // "Client_Crash_Reports(session, data)" where data includes header in Python?
            // "_, length = struct.unpack_from(">HH", data, 0)" -> This reads the header length.
            
            // In our TS Router:
            // "const payload = this.buffer.subarray(4, total);" is passed.
            // So 'data' here is just the payload string bytes?
            
            // Let's verify string encoding. Python: "payload.decode("utf-8")"
            const message = data.toString('utf-8');
            console.error(`[Client System Error] User ${client.userId}: ${message}`);
        } catch (err) {
            console.error(`[SystemHandler] Error parsing crash report`, err);
            console.error(data.toString('hex'));
        }
    }
}
