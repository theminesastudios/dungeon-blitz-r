import type { Client } from './Client';

function parseBooleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined) {
        return fallback;
    }

    switch (String(raw).trim().toLowerCase()) {
        case '1':
        case 'true':
        case 'yes':
        case 'on':
            return true;
        case '0':
        case 'false':
        case 'no':
        case 'off':
            return false;
        default:
            return fallback;
    }
}

function limitHex(data: Buffer, maxBytes: number): string {
    if (data.length <= maxBytes) {
        return data.toString('hex');
    }

    return `${data.subarray(0, maxBytes).toString('hex')}...(${data.length} bytes)`;
}

export const DebugConfig = {
    enabled: parseBooleanEnv('DEBUG_ENABLED', false),
    packets: parseBooleanEnv('DEBUG_PACKETS', parseBooleanEnv('DEBUG_ENABLED', false)),
    packetPayloads: parseBooleanEnv('DEBUG_PACKET_PAYLOADS', false),
    unhandledPackets: parseBooleanEnv('DEBUG_UNHANDLED_PACKETS', parseBooleanEnv('DEBUG_ENABLED', false)),
    router: parseBooleanEnv('DEBUG_ROUTER', parseBooleanEnv('DEBUG_ENABLED', false)),
    payloadPreviewBytes: Math.max(1, Number(process.env.DEBUG_PAYLOAD_PREVIEW_BYTES ?? 64) || 64)
};

export class DebugLogger {
    private static formatClient(client: Client | null | undefined): string {
        if (!client) {
            return 'user=- token=0 char=- level=- ent=0';
        }

        return [
            `user=${client.userId ?? '-'}`,
            `token=${client.token ?? 0}`,
            `char=${client.character?.name ?? '-'}`,
            `level=${client.currentLevel || '-'}`,
            `ent=${client.clientEntID || 0}`
        ].join(' ');
    }

    private static formatPayload(data: Buffer): string {
        const hex = DebugConfig.packetPayloads
            ? data.toString('hex')
            : limitHex(data, DebugConfig.payloadPreviewBytes);
        return `payload=${hex}`;
    }

    static log(scope: string, message: string): void {
        if (!DebugConfig.enabled) {
            return;
        }

        console.log(`[Debug][${scope}] ${message}`);
    }

    static logPacket(direction: 'IN' | 'OUT', client: Client, packetId: number, data: Buffer): void {
        if (!DebugConfig.packets) {
            return;
        }

        const details = [
            `0x${packetId.toString(16)}`,
            `len=${data.length}`,
            DebugLogger.formatClient(client),
            DebugLogger.formatPayload(data)
        ].join(' ');
        console.log(`[Debug][Packet ${direction}] ${details}`);
    }

    static logRouter(client: Client, packetId: number, handlerName: string, data: Buffer): void {
        if (!DebugConfig.router) {
            return;
        }

        console.log(
            `[Debug][Router] handled=0x${packetId.toString(16)} handler=${handlerName || 'anonymous'} len=${data.length} ${DebugLogger.formatClient(client)}`
        );
    }

    static logUnhandledPacket(client: Client, packetId: number, data: Buffer): void {
        if (!DebugConfig.unhandledPackets) {
            return;
        }

        console.warn(
            `[Debug][Unhandled] 0x${packetId.toString(16)} len=${data.length} ${DebugLogger.formatClient(client)} ${DebugLogger.formatPayload(data)}`
        );
    }

    static logStartup(): void {
        if (!DebugConfig.enabled) {
            return;
        }

        console.log(
            `[Debug] enabled packets=${DebugConfig.packets} router=${DebugConfig.router} unhandled=${DebugConfig.unhandledPackets} payloads=${DebugConfig.packetPayloads}`
        );
    }
}
