import { Client } from '../core/Client';

type PacketHandler = (client: Client, data: Buffer) => void | Promise<void>;

export class PacketRouter {
    private handlers: Map<number, PacketHandler> = new Map();

    public register(packetId: number, handler: PacketHandler): void {
        this.handlers.set(packetId, handler);
    }

    public async handle(client: Client, packetId: number, data: Buffer): Promise<void> {
        const handler = this.handlers.get(packetId);
        if (handler) {
            try {
                await handler(client, data);
            } catch (err) {
                console.error(`[Router] Error in handler for 0x${packetId.toString(16)}:`, err);
            }
        } else {
            console.warn(`[Router] Unhandled packet: 0x${packetId.toString(16)}`);
        }
    }
}
