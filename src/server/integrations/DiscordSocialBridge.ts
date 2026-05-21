import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';

import { Client as GameClient } from '../core/Client';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { DiscordSocialServerApi } from './DiscordSocialServerApi';

export type DiscordChatScope = 'public' | 'party' | 'guild' | 'officer';
type DiscordChatRelayMode = 'native' | 'bot' | 'both' | 'off';

interface DiscordSocialBridgeConfig {
    enabled?: boolean;
    nativeBridgeEnabled?: boolean;
    chatRelayMode?: string;
    appId?: string;
    channelId?: string;
    lobbySecret?: string;
    deviceFlow?: boolean;
    gameWindowPid?: number;
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
    accountEmail?: string;
    userId?: number | null;
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

interface NativeBridgeInboundChannelLinked extends NativeBridgeInboundBase {
    type: 'channel_linked';
    lobbyId?: string;
    channelId?: string;
    reusedExisting?: boolean;
}

interface NativeBridgeInboundChannelLinkFailure extends NativeBridgeInboundBase {
    type: 'channel_link_failed' | 'channel_link_conflict';
    lobbyId?: string;
    channelId?: string;
    existingLobbyId?: string;
    existingApplicationId?: string;
    errorCode?: number;
    httpStatus?: number;
    error?: string;
    responseBody?: string;
    summary?: string;
}

interface NativeBridgeInboundSendResult extends NativeBridgeInboundBase {
    type: 'send_result';
    ok: boolean;
    messageId?: string;
    error?: string;
}

type NativeBridgeInbound =
    | NativeBridgeInboundStatus
    | NativeBridgeInboundChat
    | NativeBridgeInboundReady
    | NativeBridgeInboundAuth
    | NativeBridgeInboundLobbyReady
    | NativeBridgeInboundChannelLinked
    | NativeBridgeInboundChannelLinkFailure
    | NativeBridgeInboundSendResult;

const CONFIG_CANDIDATES = [
    path.resolve(process.cwd(), 'discord-social-bridge.config.json'),
    path.resolve(__dirname, '..', 'discord-social-bridge.config.json'),
    path.resolve(__dirname, '..', '..', 'discord-social-bridge.config.json')
];
const MAX_PENDING_NATIVE_MESSAGES = 50;

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

function parseInteger(value: string | number | undefined, fallback: number): number {
    if (value == null) {
        return fallback;
    }

    const parsed = typeof value === 'number' ? value : Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

function parseChatRelayMode(value: string | undefined, fallback: DiscordChatRelayMode): DiscordChatRelayMode {
    switch (String(value ?? '').trim().toLowerCase()) {
        case 'native':
        case 'sdk':
        case 'social-sdk':
        case 'social_sdk':
            return 'native';
        case 'bot':
        case 'rest':
        case 'channel':
            return 'bot';
        case 'both':
        case 'all':
            return 'both';
        case 'off':
        case 'none':
        case 'false':
        case '0':
            return 'off';
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

    const executableName = process.platform === 'win32' ? 'discord_social_bridge.exe' : 'discord_social_bridge';
    return path.resolve(process.cwd(), 'native_bridge', 'build', executableName);
}

class DiscordSocialBridge {
    private readonly config: DiscordSocialBridgeConfig;
    private readonly enabled: boolean;
    private readonly nativeBridgeEnabled: boolean;
    private readonly chatRelayMode: DiscordChatRelayMode;
    private readonly appId: string;
    private readonly channelId: string;
    private readonly lobbySecret: string;
    private readonly deviceFlow: boolean;
    private readonly gameWindowPid: number;
    private readonly enableChannelLinking: boolean;
    private readonly executablePath: string;
    private readonly workingDirectory: string;
    private readonly tokenCachePath: string;
    private readonly logPayloads: boolean;
    private readonly inboundPrefix: string;
    private readonly serverApi: DiscordSocialServerApi;
    private child: ChildProcessWithoutNullStreams | null = null;
    private ready = false;
    private nativeLobbyReady = false;
    private nativeChannelLinked = false;
    private nativeChannelLinkFailed = false;
    private currentDiscordUserId = '';
    private started = false;
    private readonly pendingNativeOutbound: Array<Record<string, unknown>> = [];

    constructor() {
        this.config = readConfigFile();
        this.enabled = parseBoolean(process.env.DISCORD_SOCIAL_BRIDGE_ENABLED, Boolean(this.config.enabled));
        this.nativeBridgeEnabled = parseBoolean(
            process.env.DISCORD_SOCIAL_NATIVE_BRIDGE_ENABLED,
            this.config.nativeBridgeEnabled ?? false
        );
        this.chatRelayMode = parseChatRelayMode(
            process.env.DISCORD_SOCIAL_CHAT_RELAY_MODE,
            parseChatRelayMode(this.config.chatRelayMode, 'native')
        );
        this.appId = String(process.env.DISCORD_SOCIAL_APP_ID ?? this.config.appId ?? '').trim();
        this.channelId = String(process.env.DISCORD_SOCIAL_BRIDGE_CHANNEL_ID ?? this.config.channelId ?? '').trim();
        this.lobbySecret = String(process.env.DISCORD_SOCIAL_LOBBY_SECRET ?? this.config.lobbySecret ?? '').trim();
        this.deviceFlow = parseBoolean(process.env.DISCORD_SOCIAL_DEVICE_FLOW, this.config.deviceFlow ?? false);
        this.gameWindowPid = parseInteger(process.env.DISCORD_SOCIAL_GAME_WINDOW_PID, this.config.gameWindowPid ?? 0);
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
        if (!this.enabled || !this.nativeBridgeEnabled || this.started) {
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
            this.nativeLobbyReady = false;
            this.nativeChannelLinked = false;
            this.nativeChannelLinkFailed = false;
            this.currentDiscordUserId = '';
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
            lobbySecret: this.lobbySecret,
            deviceFlow: this.deviceFlow,
            gameWindowPid: this.gameWindowPid,
            enableChannelLinking: this.enableChannelLinking,
            tokenCachePath: this.tokenCachePath
        });
    }

    public relay(payload: DiscordRelayPayload): void {
        if (!this.enabled) {
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

        if (this.chatRelayMode === 'bot' || this.chatRelayMode === 'both') {
            void this.forwardToDiscordChannel({
                ...payload,
                senderName,
                message
            });
        }

        if (this.chatRelayMode !== 'native' && this.chatRelayMode !== 'both') {
            return;
        }

        if (this.nativeChannelLinkFailed) {
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

        if (!this.canSendNativeLobbyChat()) {
            this.enqueueNativeOutbound(outbound);
            return;
        }

        if (this.logPayloads) {
            console.log('[DiscordSocialBridge] Outbound:', outbound);
        }

        this.sendControlMessage(outbound);
    }

    private async forwardToDiscordChannel(payload: DiscordRelayPayload): Promise<void> {
        if (!this.channelId || !this.serverApi.isEnabled()) {
            return;
        }

        try {
            const content = await this.formatDiscordChannelMessage(payload);
            if (!content) {
                return;
            }

            await this.serverApi.sendChannelMessage(this.channelId, content);
        } catch (error) {
            console.error('[DiscordSocialBridge] Failed to forward game chat to Discord channel:', error);
        }
    }

    private async formatDiscordChannelMessage(payload: DiscordRelayPayload): Promise<string> {
        const message = DiscordSocialBridge.cleanDiscordText(payload.message, 1800);
        if (!message) {
            return '';
        }

        return message;
    }

    private static cleanDiscordText(value: string | null | undefined, maxLength: number): string {
        return String(value ?? '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, maxLength);
    }

    private sendControlMessage(payload: Record<string, unknown>): void {
        if (!this.child?.stdin.writable) {
            return;
        }

        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    }

    private canSendNativeLobbyChat(): boolean {
        if (!this.ready || !this.child || !this.nativeLobbyReady) {
            return false;
        }

        if (this.enableChannelLinking && this.channelId && this.serverApi.isEnabled()) {
            return this.nativeChannelLinked && !this.nativeChannelLinkFailed;
        }

        return true;
    }

    private enqueueNativeOutbound(payload: Record<string, unknown>): void {
        this.pendingNativeOutbound.push(payload);
        while (this.pendingNativeOutbound.length > MAX_PENDING_NATIVE_MESSAGES) {
            this.pendingNativeOutbound.shift();
        }

        if (this.logPayloads) {
            console.log('[DiscordSocialBridge] Queued native lobby chat until Social SDK lobby is ready:', payload);
        }
    }

    private flushPendingNativeOutbound(): void {
        if (!this.canSendNativeLobbyChat() || this.pendingNativeOutbound.length === 0) {
            return;
        }

        const pending = this.pendingNativeOutbound.splice(0);
        for (const payload of pending) {
            if (this.logPayloads) {
                console.log('[DiscordSocialBridge] Flushing native lobby chat:', payload);
            }
            this.sendControlMessage(payload);
        }
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
                    this.broadcastStatus(`${this.inboundPrefix} <${username}>: ${payload.message}`);
                }
                return;
            case 'lobby_ready':
                void this.handleLobbyReady(payload);
                return;
            case 'channel_linked':
                this.nativeChannelLinked = true;
                this.nativeChannelLinkFailed = false;
                console.log(
                    `[DiscordSocialBridge] Discord Social SDK lobby ${payload.lobbyId ?? 'unknown'} ${payload.reusedExisting ? 'reused existing link for' : 'linked to'} channel ${payload.channelId ?? 'unknown'}.`
                );
                this.flushPendingNativeOutbound();
                return;
            case 'channel_link_conflict':
                void this.handleChannelLinkConflict(payload);
                return;
            case 'channel_link_failed':
                this.handleChannelLinkFailed(payload);
                return;
            case 'send_result':
                if (!payload.ok) {
                    const error = String(payload.error ?? '').trim() || 'unknown error';
                    console.warn(`[DiscordSocialBridge] Native lobby send failed: ${error}`);
                    this.broadcastStatus(`Discord lobby send failed: ${error}`);
                }
                return;
            default:
                console.log(`[DiscordSocialBridge] Ignored native bridge event: ${trimmed}`);
        }
    }

    private async handleLobbyReady(payload: NativeBridgeInboundLobbyReady): Promise<void> {
        this.nativeLobbyReady = true;
        this.nativeChannelLinkFailed = false;
        this.currentDiscordUserId = String(payload.userId ?? '').trim();
        if (!this.enableChannelLinking) {
            this.flushPendingNativeOutbound();
            return;
        }

        const granted = await this.serverApi.grantCanLinkLobby(payload.lobbyId, payload.userId);
        if (!granted) {
            this.broadcastStatus('Discord lobby channel linking failed; lobby chat may not appear in Discord.');
            this.flushPendingNativeOutbound();
            return;
        }

        this.sendControlMessage({
            type: 'link_channel',
            lobbyId: payload.lobbyId,
            channelId: this.channelId
        });
    }

    private async handleChannelLinkConflict(payload: NativeBridgeInboundChannelLinkFailure): Promise<void> {
        const existingLobbyId = String(payload.existingLobbyId ?? '').trim();
        const existingApplicationId = String(payload.existingApplicationId ?? '').trim();
        if (!existingLobbyId) {
            this.handleChannelLinkFailed(payload);
            return;
        }

        if (existingApplicationId && existingApplicationId !== this.appId) {
            this.nativeChannelLinkFailed = true;
            this.pendingNativeOutbound.splice(0);
            this.broadcastStatus(
                `Discord channel is already linked to lobby ${existingLobbyId} for another app; unlink it or choose another channel.`
            );
            return;
        }

        if (!this.currentDiscordUserId) {
            this.nativeChannelLinkFailed = true;
            this.pendingNativeOutbound.splice(0);
            this.broadcastStatus('Discord channel is already linked, but the bridge could not identify the authorized Discord user.');
            return;
        }

        const granted = await this.serverApi.grantCanLinkLobby(existingLobbyId, this.currentDiscordUserId);
        if (!granted) {
            this.nativeChannelLinkFailed = true;
            this.pendingNativeOutbound.splice(0);
            this.broadcastStatus('Discord channel is already linked, and the bridge could not grant access to the existing lobby.');
            return;
        }

        console.warn(
            `[DiscordSocialBridge] Channel ${payload.channelId ?? this.channelId} is already linked to lobby ${existingLobbyId}; trying to reuse that lobby.`
        );
        this.sendControlMessage({
            type: 'use_lobby',
            lobbyId: existingLobbyId,
            channelId: payload.channelId ?? this.channelId
        });
    }

    private handleChannelLinkFailed(payload: NativeBridgeInboundChannelLinkFailure): void {
        this.nativeChannelLinkFailed = true;
        this.pendingNativeOutbound.splice(0);
        const code = Number.isFinite(payload.errorCode) && payload.errorCode ? ` code=${payload.errorCode}` : '';
        const summary = String(payload.error || payload.summary || payload.responseBody || 'unknown error').trim();
        const conflictHint = payload.errorCode === 50237
            ? ' The Discord channel is already linked to another lobby; use the same DISCORD_SOCIAL_LOBBY_SECRET or unlink that lobby before retrying.'
            : '';
        this.broadcastStatus(`Discord lobby channel linking failed${code}: ${summary}${conflictHint}`);
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
