import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';

import { Client as GameClient } from '../core/Client';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { DiscordSocialServerApi } from './DiscordSocialServerApi';

export type DiscordChatScope = 'public' | 'party' | 'guild' | 'officer';

interface DiscordSocialBridgeConfig {
    enabled?: boolean;
    appId?: string;
    channelId?: string;
    deviceFlow?: boolean;
    enableChannelLinking?: boolean;
    executablePath?: string;
    workingDirectory?: string;
    tokenCachePath?: string;
    logPayloads?: boolean;
    inboundPrefix?: string;
}

interface DiscordRelayPayload {
    scope: DiscordChatScope;
    senderName: string;
    message: string;
    levelName?: string;
    guildName?: string;
    partyId?: number;
}

interface NativeBridgeInboundBase {
    type: string;
}

interface NativeBridgeInboundStatus extends NativeBridgeInboundBase {
    type: 'status';
    text: string;
}

interface NativeBridgeInboundChat extends NativeBridgeInboundBase {
    type: 'chat';
    username: string;
    message: string;
}

interface NativeBridgeInboundReady extends NativeBridgeInboundBase {
    type: 'ready';
}

interface NativeBridgeInboundAuth extends NativeBridgeInboundBase {
    type: 'auth';
    verificationUri?: string;
    userCode?: string;
}

interface NativeBridgeInboundLobbyReady extends NativeBridgeInboundBase {
    type: 'lobby_ready';
    lobbyId: string;
    userId: string;
}

type NativeBridgeInbound =
    | NativeBridgeInboundStatus
    | NativeBridgeInboundChat
    | NativeBridgeInboundReady
    | NativeBridgeInboundAuth
    | NativeBridgeInboundLobbyReady;

const CONFIG_CANDIDATES = [
    path.resolve(process.cwd(), 'discord-social-bridge.config.json'),
    path.resolve(__dirname, '..', 'discord-social-bridge.config.json'),
    path.resolve(__dirname, '..', '..', 'discord-social-bridge.config.json')
];

function readConfigFile(): DiscordSocialBridgeConfig {
    for (const candidate of CONFIG_CANDIDATES) {
        if (!fs.existsSync(candidate)) {
            continue;
        }

        try {
            const raw = fs.readFileSync(candidate, 'utf8');
            const parsed = JSON.parse(raw) as DiscordSocialBridgeConfig;
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            console.error(`[DiscordSocialBridge] Failed to parse config ${candidate}:`, error);
            return {};
        }
    }

    return {};
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value == null) {
        return fallback;
    }

    switch (value.trim().toLowerCase()) {
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

function buildStatusPayload(text: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod13(text);
    return bb.toBuffer();
}

function resolveExecutablePath(config: DiscordSocialBridgeConfig): string {
    const configured = String(process.env.DISCORD_SOCIAL_BRIDGE_EXECUTABLE ?? config.executablePath ?? '').trim();
    if (configured) {
        return configured;
    }

    return path.resolve(process.cwd(), 'native_bridge', 'build', 'discord_social_bridge');
}

class DiscordSocialBridge {
    private readonly config: DiscordSocialBridgeConfig;
    private readonly enabled: boolean;
    private readonly appId: string;
    private readonly channelId: string;
    private readonly deviceFlow: boolean;
    private readonly enableChannelLinking: boolean;
    private readonly executablePath: string;
    private readonly workingDirectory: string;
    private readonly tokenCachePath: string;
    private readonly logPayloads: boolean;
    private readonly inboundPrefix: string;
    private readonly serverApi: DiscordSocialServerApi;
    private child: ChildProcessWithoutNullStreams | null = null;
    private ready = false;
    private started = false;

    constructor() {
        this.config = readConfigFile();
        this.enabled = parseBoolean(process.env.DISCORD_SOCIAL_BRIDGE_ENABLED, Boolean(this.config.enabled));
        this.appId = String(process.env.DISCORD_SOCIAL_APP_ID ?? this.config.appId ?? '').trim();
        this.channelId = String(process.env.DISCORD_SOCIAL_BRIDGE_CHANNEL_ID ?? this.config.channelId ?? '').trim();
        this.deviceFlow = parseBoolean(process.env.DISCORD_SOCIAL_DEVICE_FLOW, this.config.deviceFlow ?? true);
        this.enableChannelLinking = parseBoolean(
            process.env.DISCORD_SOCIAL_ENABLE_CHANNEL_LINKING,
            this.config.enableChannelLinking ?? false
        );
        this.executablePath = resolveExecutablePath(this.config);
        this.workingDirectory = String(this.config.workingDirectory ?? path.dirname(this.executablePath)).trim() || path.dirname(this.executablePath);
        this.tokenCachePath =
            String(this.config.tokenCachePath ?? path.resolve(process.cwd(), '.discord-social-token.json')).trim() ||
            path.resolve(process.cwd(), '.discord-social-token.json');
        this.logPayloads = parseBoolean(process.env.DISCORD_SOCIAL_BRIDGE_LOG_PAYLOADS, Boolean(this.config.logPayloads));
        this.inboundPrefix = String(this.config.inboundPrefix ?? '[Discord]').trim() || '[Discord]';
        this.serverApi = new DiscordSocialServerApi();
    }

    public initialize(): void {
        if (!this.enabled || this.started) {
            return;
        }

        this.started = true;

        if (!this.appId) {
            console.warn('[DiscordSocialBridge] Bridge enabled but appId is missing.');
            return;
        }

        if (!this.channelId) {
            console.warn('[DiscordSocialBridge] Bridge enabled but channelId is missing.');
            return;
        }

        if (!fs.existsSync(this.executablePath)) {
            console.warn(`[DiscordSocialBridge] Native bridge executable not found: ${this.executablePath}`);
            console.warn('[DiscordSocialBridge] Build the native Social SDK bridge first.');
            return;
        }

        this.child = spawn(this.executablePath, [], {
            cwd: this.workingDirectory,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        this.child.on('exit', (code, signal) => {
            this.ready = false;
            this.child = null;
            console.warn(`[DiscordSocialBridge] Native bridge exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`);
        });

        this.child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8').trim();
            if (text) {
                console.log(`[DiscordSocialBridge:native] ${text}`);
            }
        });

        const rl = readline.createInterface({ input: this.child.stdout });
        rl.on('line', (line) => {
            this.handleInboundLine(line);
        });

        this.sendControlMessage({
            type: 'initialize',
            appId: this.appId,
            channelId: this.channelId,
            deviceFlow: this.deviceFlow,
            enableChannelLinking: this.enableChannelLinking,
            tokenCachePath: this.tokenCachePath
        });
    }

    public relay(payload: DiscordRelayPayload): void {
        if (!this.enabled || !this.ready || !this.child) {
            return;
        }

        if (payload.scope !== 'public') {
            return;
        }

        const senderName = String(payload.senderName ?? '').trim();
        const message = String(payload.message ?? '').trim();
        if (!senderName || !message) {
            return;
        }

        const outbound = {
            type: 'outbound_chat',
            scope: payload.scope,
            senderName,
            message,
            levelName: payload.levelName ?? '',
            guildName: payload.guildName ?? '',
            partyId: payload.partyId ?? 0
        };

        if (this.logPayloads) {
            console.log('[DiscordSocialBridge] Outbound:', outbound);
        }

        this.sendControlMessage(outbound);
    }

    private sendControlMessage(payload: Record<string, unknown>): void {
        if (!this.child?.stdin.writable) {
            return;
        }

        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    }

    private handleInboundLine(line: string): void {
        const trimmed = String(line ?? '').trim();
        if (!trimmed) {
            return;
        }

        let payload: NativeBridgeInbound;
        try {
            payload = JSON.parse(trimmed) as NativeBridgeInbound;
        } catch (error) {
            console.error('[DiscordSocialBridge] Failed to parse native bridge output:', error);
            return;
        }

        if (this.logPayloads) {
            console.log('[DiscordSocialBridge] Inbound:', payload);
        }

        switch (payload.type) {
            case 'ready':
                this.ready = true;
                console.log('[DiscordSocialBridge] Native Social SDK bridge is ready.');
                return;
            case 'auth':
                console.log(
                    `[DiscordSocialBridge] Device auth required: ${payload.verificationUri ?? 'verification_uri_missing'} code=${payload.userCode ?? 'missing'}`
                );
                return;
            case 'status':
                this.broadcastStatus(payload.text);
                return;
            case 'chat':
                {
                    const username = String(payload.username ?? '').trim() || 'Discord';
                    this.broadcastStatus(`${this.inboundPrefix} ${username}: ${payload.message}`);
                }
                return;
            case 'lobby_ready':
                void this.handleLobbyReady(payload);
                return;
            default:
                console.log(`[DiscordSocialBridge] Ignored native bridge event: ${trimmed}`);
        }
    }

    private async handleLobbyReady(payload: NativeBridgeInboundLobbyReady): Promise<void> {
        if (!this.enableChannelLinking) {
            return;
        }

        const granted = await this.serverApi.grantCanLinkLobby(payload.lobbyId, payload.userId);
        if (!granted) {
            return;
        }

        this.sendControlMessage({
            type: 'link_channel',
            lobbyId: payload.lobbyId,
            channelId: this.channelId
        });
    }

    private broadcastStatus(text: string): void {
        const message = String(text ?? '').trim();
        if (!message) {
            return;
        }

        const payload = buildStatusPayload(message);
        for (const session of GlobalState.sessionsByToken.values()) {
            if (!this.canReceiveInbound(session)) {
                continue;
            }

            session.send(0x44, payload);
        }
    }

    private canReceiveInbound(session: GameClient): boolean {
        return Boolean(session.character && session.playerSpawned);
    }
}

export const discordSocialBridge = new DiscordSocialBridge();
