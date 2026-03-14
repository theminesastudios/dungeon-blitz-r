import * as net from 'net';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { PacketRouter } from '../network/packetRouter';
import { UserAccount, Character } from '../database/Database';

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

            const payload = Buffer.from(this.buffer.subarray(4, total));
            this.buffer = this.buffer.subarray(total);

            this.packetQueue = this.packetQueue
                .then(async () => {
                    await this.router.handle(this, packetId, payload);
                })
                .catch((err: unknown) => {
                    console.error(`[Client] Error handling packet 0x${packetId.toString(16)}:`, err);
                });
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
        const { GlobalState } = require('./GlobalState') as typeof import('./GlobalState');
        const { EntityHandler } = require('../handlers/EntityHandler') as typeof import('../handlers/EntityHandler');

        EntityHandler.removeOwnedEntities(this);

        if (this.token && GlobalState.sessionsByToken.get(this.token) === this) {
            GlobalState.sessionsByToken.delete(this.token);
        }
        if (this.userId && GlobalState.sessionsByUserId.get(this.userId) === this) {
            GlobalState.sessionsByUserId.delete(this.userId);
        }

        this.playerSpawned = false;
        this.entities.clear();
        this.pendingLoot.clear();
        this.processedRewardSources.clear();
        this.pendingMissionTurnIns.clear();
        this.clientSpawnConfirmed = false;
        clearClientSpawnFallbackTimer(this);
        clearKeepTutorialTimers(this.keepTutorialState);
        this.keepTutorialState = null;

        console.log(`[Client] Disconnected`);
    }

    private onError(err: Error): void {
        console.error(`[Client] Error:`, err);
    }
}
