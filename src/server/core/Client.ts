import * as net from 'net';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { PacketRouter } from '../network/packetRouter';
import { UserAccount, Character } from '../database/Database';

export class Client {
    public socket: net.Socket;
    public router: PacketRouter;
    private buffer: Buffer;

    // Session State
    public userId: number | null = null;
    public authenticated: boolean = false;
    public account: UserAccount | null = null;
    public characters: Character[] = [];
    public character: Character | null = null;
    public challengeStr: string = "";

    // Entity State
    public token: number = 0;
    public clientEntID: number = 0;
    public entities: Map<number, any> = new Map();
    public currentLevel: string = "";
    public playerSpawned: boolean = false;

    constructor(socket: net.Socket, router: PacketRouter) {
        this.socket = socket;
        this.router = router;
        this.buffer = Buffer.alloc(0);

        this.socket.on('data', (data: Buffer) => this.onData(data));
        this.socket.on('close', () => this.onClose());
        this.socket.on('error', (err: Error) => this.onError(err));
    }

    private onData(data: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, data]);
        
        while (this.buffer.length >= 4) {
            // Read Header
            const packetId = this.buffer.readUInt16BE(0);
            const length = this.buffer.readUInt16BE(2);
            const total = 4 + length;

            if (this.buffer.length < total) {
                break; // Wait for more data
            }

            const payload = this.buffer.subarray(4, total);
            this.buffer = this.buffer.subarray(total);

            // Handle Packet
            // console.log(`[Client] Received Packet 0x${packetId.toString(16)} (len=${length})`);
            try {
                // Ensure we handle the promise if it's async, though onData used to be sync-ish.
                // onData is void, but we can call async func.
                this.router.handle(this, packetId, payload).catch(err => {
                     console.error(`[Client] Async Error handling packet 0x${packetId.toString(16)}:`, err);
                });
            } catch (err) {
                console.error(`[Client] Sync Error handling packet 0x${packetId.toString(16)}:`, err);
            }
        }
    }

    public send(packetId: number, buffer: Buffer): void {
        const header = Buffer.alloc(4);
        header.writeUInt16BE(packetId, 0);
        header.writeUInt16BE(buffer.length, 2);
        this.socket.write(Buffer.concat([header, buffer]));
    }

    public sendBitBuffer(packetId: number, bb: BitBuffer): void {
        this.send(packetId, bb.toBuffer());
    }

    private onClose(): void {
        console.log(`[Client] Disconnected`);
    }

    private onError(err: Error): void {
        console.error(`[Client] Error:`, err);
    }
}
