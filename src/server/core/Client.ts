import * as net from 'net';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { PacketRouter } from '../network/packetRouter';
import { UserAccount, Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { DebugLogger } from './Debug';

const db = new JsonAdapter();
const SOCKET_POLICY_REQUEST = '<policy-file-request/>';
const SOCKET_POLICY_RESPONSE = `<?xml version="1.0"?>
<!DOCTYPE cross-domain-policy SYSTEM
  "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd">
<cross-domain-policy>
  <allow-access-from domain="*" to-ports="1-65535" secure="false"/>
</cross-domain-policy>\0`;

export interface PendingLootDrop {
    gold?: number;
    health?: number;
    gear?: number;
    tier?: number;
    material?: number;
}

export interface KeepTutorialState {
    phase: number;
    bossDefeated: boolean;
    bossIntroForced: boolean;
    bossRecoveryArmed: boolean;
    forcedLastGuyId: number | null;
    bossEntitySeen: number | null;
    bossEntitySource: 'client' | 'fallback' | null;
    introSkitSent: boolean;
    bossMusicStarted: boolean;
    bossInfoSentIds: Set<number>;
    introTimers: NodeJS.Timeout[];
    recoverySpawnTimer: NodeJS.Timeout | null;
    recoveryActivateTimer: NodeJS.Timeout | null;
    bossWounded60: boolean;
    bossWounded30: boolean;
    helperEntityIds: number[];
}

export function createKeepTutorialState(): KeepTutorialState {
    return {
        phase: 0,
        bossDefeated: false,
        bossIntroForced: false,
        bossRecoveryArmed: false,
        forcedLastGuyId: null,
        bossEntitySeen: null,
        bossEntitySource: null,
        introSkitSent: false,
        bossMusicStarted: false,
        bossInfoSentIds: new Set<number>(),
        introTimers: [],
        recoverySpawnTimer: null,
        recoveryActivateTimer: null,
        bossWounded60: false,
        bossWounded30: false,
        helperEntityIds: [],
    };
}

export function clearKeepTutorialTimers(state: KeepTutorialState | null | undefined): void {
    if (!state) {
        return;
    }

    if (state.recoverySpawnTimer) {
        clearTimeout(state.recoverySpawnTimer);
        state.recoverySpawnTimer = null;
    }

    for (const timer of state.introTimers) {
        clearTimeout(timer);
    }
    state.introTimers = [];

    if (state.recoveryActivateTimer) {
        clearTimeout(state.recoveryActivateTimer);
        state.recoveryActivateTimer = null;
    }
}

export function clearClientSpawnFallbackTimer(client: Pick<Client, 'clientSpawnFallbackTimer'>): void {
    if (client.clientSpawnFallbackTimer) {
        clearTimeout(client.clientSpawnFallbackTimer);
        client.clientSpawnFallbackTimer = null;
    }
}

export class Client {
    public socket: net.Socket;
    public router: PacketRouter;
    private buffer: Buffer;
    private packetQueue: Promise<void>;
    private rawBytesIn: number;
    private rawBytesOut: number;

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
    public entryLevel: string = "";
    public currentRoomId: number = -1;
    public lastDoorId: number = -1;
    public lastDoorTargetLevel: string = "";
    public playerSpawned: boolean = false;
    public mountTransferGraceUntil: number = 0;
    public startedRoomEvents: Set<string> = new Set();
    public pendingLoot: Map<number, PendingLootDrop> = new Map();
    public processedRewardSources: Set<string> = new Set();
    public pendingMissionTurnIns: Set<number> = new Set();
    public authoritativeMaxHp: number = 100;
    public authoritativeCurrentHp: number = 100;
    public clientSpawnConfirmed: boolean = false;
    public clientSpawnFallbackTimer: NodeJS.Timeout | null = null;
    public keepTutorialState: KeepTutorialState | null = null;

    constructor(socket: net.Socket, router: PacketRouter) {
        this.socket = socket;
        this.router = router;
        this.buffer = Buffer.alloc(0);
        this.packetQueue = Promise.resolve();
        this.rawBytesIn = 0;
        this.rawBytesOut = 0;

        this.socket.on('data', (data: Buffer) => this.onData(data));
        this.socket.on('end', () => this.onEnd());
        this.socket.on('close', (hadError: boolean) => this.onClose(hadError));
        this.socket.on('error', (err: Error) => this.onError(err));
    }

    private onData(data: Buffer): void {
        this.rawBytesIn += data.length;
        this.buffer = Buffer.concat([this.buffer, data]);

        if (this.tryServeSocketPolicy()) {
            return;
        }
        
        while (this.buffer.length >= 4) {
            // Read Header
            const packetId = this.buffer.readUInt16BE(0);
            const length = this.buffer.readUInt16BE(2);
            const total = 4 + length;

            if (this.buffer.length < total) {
                break; // Wait for more data
            }

            const payload = Buffer.from(this.buffer.subarray(4, total));
            this.buffer = this.buffer.subarray(total);
            DebugLogger.logPacket('IN', this, packetId, payload);

            this.packetQueue = this.packetQueue
                .then(async () => {
                    await this.router.handle(this, packetId, payload);
                })
                .catch((err: unknown) => {
                    console.error(`[Client] Error handling packet 0x${packetId.toString(16)}:`, err);
                });
        }
    }

    private tryServeSocketPolicy(): boolean {
        if (this.buffer.length === 0 || this.buffer[0] !== 0x3c) {
            return false;
        }

        const incoming = this.buffer.toString('utf8');
        if (!incoming.includes(SOCKET_POLICY_REQUEST)) {
            return false;
        }

        const addr = `${this.socket.remoteAddress}:${this.socket.remotePort}`;
        this.rawBytesOut += Buffer.byteLength(SOCKET_POLICY_RESPONSE);
        this.buffer = Buffer.alloc(0);
        console.log(`[Client] Served inline socket policy to ${addr}`);
        this.socket.end(SOCKET_POLICY_RESPONSE);
        return true;
    }

    public send(packetId: number, buffer: Buffer): void {
        const header = Buffer.alloc(4);
        header.writeUInt16BE(packetId, 0);
        header.writeUInt16BE(buffer.length, 2);
        DebugLogger.logPacket('OUT', this, packetId, buffer);
        const payload = Buffer.concat([header, buffer]);
        this.rawBytesOut += payload.length;
        this.socket.write(payload);
    }

    public sendBitBuffer(packetId: number, bb: BitBuffer): void {
        this.send(packetId, bb.toBuffer());
    }

    private onEnd(): void {
        const addr = `${this.socket.remoteAddress}:${this.socket.remotePort}`;
        console.log(
            `[Client] Socket ended: ${addr} bytesIn=${this.rawBytesIn} bytesOut=${this.rawBytesOut} authenticated=${this.authenticated}`
        );
    }

    private onClose(hadError: boolean): void {
        const { GlobalState } = require('./GlobalState') as typeof import('./GlobalState');
        const { EntityHandler } = require('../handlers/EntityHandler') as typeof import('../handlers/EntityHandler');
        const addr = `${this.socket.remoteAddress}:${this.socket.remotePort}`;

        if (this.userId && this.character) {
            void db.saveCharacterSnapshot(this.userId, this.character).catch((err) => {
                console.error('[Client] Failed to persist character on disconnect:', err);
            });
        }

        EntityHandler.removeOwnedEntities(this);

        if (this.token && GlobalState.sessionsByToken.get(this.token) === this) {
            GlobalState.sessionsByToken.delete(this.token);
        }
        if (this.userId && GlobalState.sessionsByUserId.get(this.userId) === this) {
            GlobalState.sessionsByUserId.delete(this.userId);
        }

        this.playerSpawned = false;
        this.mountTransferGraceUntil = 0;
        this.entities.clear();
        this.pendingLoot.clear();
        this.processedRewardSources.clear();
        this.pendingMissionTurnIns.clear();
        this.clientSpawnConfirmed = false;
        clearClientSpawnFallbackTimer(this);
        clearKeepTutorialTimers(this.keepTutorialState);
        this.keepTutorialState = null;

        console.log(
            `[Client] Disconnected: ${addr} hadError=${hadError} bytesIn=${this.rawBytesIn} bytesOut=${this.rawBytesOut} authenticated=${this.authenticated} token=${this.token}`
        );
    }

    private onError(err: Error): void {
        const addr = `${this.socket.remoteAddress}:${this.socket.remotePort}`;
        console.error(`[Client] Error from ${addr}:`, err);
    }
}
