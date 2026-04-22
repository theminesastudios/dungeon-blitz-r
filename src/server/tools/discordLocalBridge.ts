import express from 'express';
import type { Request } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { Config } from '../core/config';

interface DiscordRpcClient {
    on(
        event: 'ready' | 'disconnected' | 'error' | 'ACTIVITY_JOIN' | 'ACTIVITY_JOIN_REQUEST',
        listener: (...args: unknown[]) => void
    ): void;
    login(options: { clientId: string; scopes?: string[] }): Promise<void>;
    setActivity(activity: Record<string, unknown>, pid?: number): Promise<void>;
    clearActivity(pid?: number): Promise<void>;
    subscribe(event: string, args?: Record<string, unknown>): Promise<{ unsubscribe: () => Promise<unknown> }>;
    sendJoinInvite(user: { id: string } | string): Promise<void>;
    closeJoinRequest(user: { id: string } | string): Promise<void>;
    destroy(): Promise<void>;
}

interface DiscordRpcLibrary {
    register(clientId: string): void;
    Client: new (options: { transport: 'ipc' | 'websocket'; origin?: string }) => DiscordRpcClient;
}

interface BridgeConfig {
    appId: string;
    port: number;
    presenceUrl: string;
    joinUrl: string;
    characterName: string;
    pollMs: number;
    largeImageText: string;
    smallImageKey: string;
    smallImageText: string;
    largeImageHomeKey: string;
    largeImageDungeonKey: string;
    largeImageNewbieRoadKey: string;
    logPayloads: boolean;
    targetProcessName: string;
}

interface PresencePayload {
    characterName?: string;
    characterClass?: string;
    details?: string;
    state?: string;
    startedAtMs?: number;
    partySize?: number;
    partyId?: number;
    partyMax?: number;
    partyLocked?: boolean;
    joinSecret?: string;
    levelKey?: string;
    levelName?: string;
    areaKey?: string;
    disciplineKey?: string;
    activityKind?: string;
    playerStatus?: string;
    presenceUrl?: string;
    joinUrl?: string;
}

const DEFAULT_PORT = 47631;
const PARTY_MAX_MEMBERS = 4;

function buildLocalPresenceEndpoint(pathname: string): string {
    return `http://127.0.0.1:${Config.STATIC_PORT}${pathname}`;
}

function preferLocalDevUrl(rawUrl: string, pathname: string): string {
    const trimmed = String(rawUrl ?? '').trim();
    if (Config.MULTIPLAYER_MODE) {
        return trimmed || buildLocalPresenceEndpoint(pathname);
    }

    if (!trimmed) {
        return buildLocalPresenceEndpoint(pathname);
    }

    try {
        const parsed = new URL(trimmed);
        if (parsed.hostname === Config.MULTIPLAYER_HOST) {
            parsed.protocol = 'http:';
            parsed.hostname = '127.0.0.1';
            parsed.port = String(Config.STATIC_PORT);
            parsed.pathname = pathname;
            parsed.search = '';
            parsed.hash = '';
            return parsed.toString();
        }
    } catch (_error) {
        return buildLocalPresenceEndpoint(pathname);
    }

    return trimmed;
}

function resolveConfigPath(): string {
    const explicitArg = String(process.argv[2] ?? '').trim();
    const explicitEnv = String(process.env.DISCORD_BRIDGE_CONFIG ?? '').trim();
    const candidates = [
        explicitArg ? path.resolve(process.cwd(), explicitArg) : '',
        explicitEnv ? path.resolve(process.cwd(), explicitEnv) : '',
        path.resolve(process.cwd(), 'discord-bridge.config.json'),
        path.resolve(__dirname, '..', 'discord-bridge.config.json'),
        path.resolve(__dirname, '..', '..', 'discord-bridge.config.json')
    ];

    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return candidates[0];
}

const CONFIG_PATH = resolveConfigPath();

class LocalDiscordBridge {
    private readonly app = express();
    private readonly config: BridgeConfig;
    private client: DiscordRpcClient | null = null;
    private discordRpc: DiscordRpcLibrary | null = null;
    private transport: 'ipc' = 'ipc';
    private ready = false;
    private lastActivityHash = '';
    private pollTimer: NodeJS.Timeout | null = null;
    private currentPresence: PresencePayload | null = null;
    private runtimePresenceUrl = '';
    private runtimeJoinUrl = '';
    private runtimeCharacterName = '';
    private targetPid: number | null = null;
    private connectAttempt = 0;
    private connectTimer: NodeJS.Timeout | null = null;

    constructor(config: BridgeConfig) {
        this.config = config;
        this.app.use(express.json({ limit: '64kb' }));
        this.app.use((req, res, next) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
            if (req.method === 'OPTIONS') {
                res.status(204).end();
                return;
            }
            next();
        });
        this.setupRoutes();
    }

    async start(): Promise<void> {
        if (!this.config.appId) {
            console.error(`[DiscordBridge] Missing appId in ${CONFIG_PATH}`);
            return;
        }

        let discordRpc: DiscordRpcLibrary;
        try {
            discordRpc = require('discord-rpc') as DiscordRpcLibrary;
        } catch (error) {
            console.error('[DiscordBridge] discord-rpc package is not installed:', error);
            return;
        }

        this.discordRpc = discordRpc;
        try {
            this.discordRpc.register(this.config.appId);
        } catch (error) {
            console.error('[DiscordBridge] Failed to register appId:', error);
        }
        await this.createRpcClient();

        this.app.listen(this.config.port, '127.0.0.1', () => {
            console.log(`[DiscordBridge] Listening on http://127.0.0.1:${this.config.port}`);
        });

        this.updateTargetPid();
        this.startPolling();

        await this.tryLogin();
    }



    private async createRpcClient(): Promise<void> {
        if (!this.discordRpc) {
            return;
        }

        if (this.client) {
            try {
                await this.client.destroy();
            } catch {
                // Ignore destruction errors
            }
        }

        this.transport = 'ipc';
        this.client = new this.discordRpc.Client({ transport: 'ipc' });

        this.client.on('ready', () => {
            this.ready = true;
            this.connectAttempt = 0;
            console.log(`[DiscordBridge] Connected to local Discord client. (transport=${this.transport})`);
            void this.subscribeToDiscordEvents();
        });

        this.client.on('disconnected', () => {
            this.ready = false;
            this.lastActivityHash = '';
            console.log('[DiscordBridge] Disconnected from local Discord client.');
            this.scheduleReconnect();
        });

        this.client.on('error', (error: unknown) => {
            console.error('[DiscordBridge] Discord client error:', error);
            if (error && typeof error === 'object' && 'code' in error) {
                console.error('[DiscordBridge] Error Code:', (error as any).code);
            }
            this.ready = false;
            this.lastActivityHash = '';
            this.scheduleReconnect();
        });

        this.client.on('ACTIVITY_JOIN', (data: unknown) => {
            void this.handleDiscordActivityJoin(data);
        });

        this.client.on('ACTIVITY_JOIN_REQUEST', (data: unknown) => {
            void this.handleDiscordActivityJoinRequest(data);
        });
    }

    private scheduleReconnect(): void {
        if (this.connectTimer) {
            return;
        }

        const attempt = Math.max(0, Math.min(30, this.connectAttempt));
        const delayMs = Math.min(60_000, 1_000 * Math.pow(2, attempt));
        this.connectAttempt = attempt + 1;

        this.connectTimer = setTimeout(() => {
            this.connectTimer = null;
            void this.tryLogin();
        }, delayMs);
    }

    private async tryLogin(): Promise<void> {
        if (this.ready) {
            return;
        }

        try {
            await this.createRpcClient();
            await new Promise((resolve) => setTimeout(resolve, 1000));
            console.log(`[DiscordBridge] Connecting to local Discord client... (transport=${this.transport})`);
            await this.client!.login({ clientId: this.config.appId });
        } catch (error) {
            console.error('[DiscordBridge] Full Login Error:', error);
            const code = String((error as any)?.code ?? '').trim();
            const message = error instanceof Error ? error.message : String(error ?? '');
            if (this.config.logPayloads || this.connectAttempt % 1 === 0) {
                console.error(
                    '[DiscordBridge] Failed to connect to local Discord client:',
                    code ? `${code} ${message}` : message
                );
            }
            this.scheduleReconnect();
        }
    }


    private setupRoutes(): void {
        this.app.get('/healthz', (_req, res) => {
            res.json({
                ok: true,
                ready: this.ready
            });
        });

        this.app.post('/configure', async (req, res) => {
            const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
            const nextPresenceUrl = this.normalizeUrl(body.presenceUrl);
            const nextJoinUrl = this.normalizeUrl(body.joinUrl);
            const nextCharacterName = String(body.characterName ?? '').trim();

            if (nextPresenceUrl) {
                this.runtimePresenceUrl = nextPresenceUrl;
            }

            if (nextJoinUrl) {
                this.runtimeJoinUrl = nextJoinUrl;
            }

            if (nextCharacterName) {
                this.runtimeCharacterName = nextCharacterName;
            }

            res.json({
                ok: true,
                presenceUrl: this.buildPresenceUrl(),
                joinUrl: this.buildJoinUrl()
            });

            await this.pollPresenceServer();
        });

        this.app.post('/presence', async (req, res) => {
            const payload = this.normalizePayload(req);
            if (!payload) {
                await this.clearActivity();
                res.status(202).json({ ok: true, cleared: true });
                return;
            }

            if (payload.presenceUrl) {
                this.runtimePresenceUrl = payload.presenceUrl;
            }

            if (payload.joinUrl) {
                this.runtimeJoinUrl = payload.joinUrl;
            }

            if (this.config.logPayloads) {
                console.log('[DiscordBridge] Incoming payload:', payload);
            }

            const updated = await this.applyActivity(payload);
            res.status(updated ? 200 : 202).json({ ok: true, updated });
        });

        this.app.post('/clear', async (_req, res) => {
            await this.clearActivity();
            res.json({ ok: true, cleared: true });
        });
    }

    private normalizePayload(req: Request): PresencePayload | null {
        const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
        const clear = Boolean(body.clear);
        if (clear) {
            return null;
        }

        const characterName = String(body.characterName ?? '').trim();
        const details = String(body.details ?? '').trim();
        const state = String(body.state ?? '').trim();
        const startedAtMs = Number(body.startedAtMs ?? 0);
        const partySize = Number(body.partySize ?? 0);
        const partyId = Number(body.partyId ?? 0);
        const partyMax = Number(body.partyMax ?? PARTY_MAX_MEMBERS);
        const partyLocked = Boolean(body.partyLocked);
        const joinSecret = String(body.joinSecret ?? '').trim();
        const levelKey = String(body.levelKey ?? '').trim();
        const activityKind = String(body.activityKind ?? '').trim();
        const presenceUrl = this.normalizeUrl(body.presenceUrl);
        const joinUrl = this.normalizeUrl(body.joinUrl);
        const areaKey = String(body.areaKey ?? '').trim();
        const disciplineKey = String(body.disciplineKey ?? '').trim();
        const playerStatus = String(body.playerStatus ?? '').trim();
        const levelName = String(body.levelName ?? '').trim();
        const characterClass = String(body.characterClass ?? '').trim();

        if (!characterName || !details || !state || !Number.isFinite(startedAtMs) || startedAtMs <= 0) {
            return null;
        }

        return {
            characterName,
            characterClass,
            details,
            state,
            startedAtMs,
            partySize: Number.isFinite(partySize) ? Math.max(0, Math.round(partySize)) : 0,
            partyId: Number.isFinite(partyId) && partyId > 0 ? Math.round(partyId) : 0,
            partyMax: Number.isFinite(partyMax) ? Math.max(1, Math.round(partyMax)) : PARTY_MAX_MEMBERS,
            partyLocked,
            joinSecret,
            levelKey,
            levelName,
            areaKey,
            disciplineKey,
            activityKind,
            playerStatus,
            presenceUrl,
            joinUrl
        };
    }

    private startPolling(): void {
        const presenceUrl = this.getActivePresenceUrl();
        if (!presenceUrl) {
            return;
        }

        const pollMs = Math.max(2000, this.config.pollMs);
        this.pollTimer = setInterval(() => {
            void this.pollPresenceServer();
        }, pollMs);

        console.log(
            `[DiscordBridge] Polling ${this.buildPresenceUrl()} every ${pollMs}ms` +
                (this.config.characterName ? ` for "${this.config.characterName}"` : '')
        );
        void this.pollPresenceServer();
    }

    private buildPresenceUrl(): string {
        const activePresenceUrl = this.getActivePresenceUrl();
        if (!activePresenceUrl) {
            return '';
        }

        const url = new URL(activePresenceUrl);
        const characterName = this.getActiveCharacterName();
        if (characterName) {
            url.searchParams.set('character', characterName);
        }
        return url.toString();
    }

    private async pollPresenceServer(): Promise<void> {
        const presenceUrl = this.getActivePresenceUrl();
        if (!presenceUrl) {
            return;
        }

        try {
            const response = await fetch(this.buildPresenceUrl(), {
                cache: 'no-store'
            });

            if (!response.ok) {
                await this.clearActivity();
                return;
            }

            const data = await response.json() as { session?: Record<string, unknown> | null };
            const session = data && data.session ? data.session : null;
            if (!session) {
                await this.clearActivity();
                return;
            }

            const payload: PresencePayload = {
                characterName: String(session.characterName ?? '').trim(),
                details: String(session.details ?? '').trim(),
                state: String(session.state ?? '').trim(),
                startedAtMs: Number(session.startedAtMs ?? 0),
                partySize: Number(session.partySize ?? 0),
                partyId: Number(session.partyId ?? 0),
                partyMax: Number(session.partyMax ?? PARTY_MAX_MEMBERS),
                partyLocked: Boolean(session.partyLocked),
                joinSecret: String(session.joinSecret ?? '').trim(),
                levelKey: String(session.levelKey ?? '').trim(),
                activityKind: String(session.activityKind ?? '').trim(),
                areaKey: String(session.areaKey ?? '').trim(),
                disciplineKey: String(session.disciplineKey ?? '').trim(),
                playerStatus: String(session.playerStatus ?? '').trim(),
                levelName: String(session.levelName ?? '').trim(),
                characterClass: String(session.characterClass ?? '').trim()
            };

            if (!payload.characterName || !payload.details || !payload.state || !payload.startedAtMs) {
                await this.clearActivity();
                return;
            }

            if (this.config.logPayloads) {
                console.log('[DiscordBridge] Polled payload:', payload);
            }

            await this.applyActivity(payload);
        } catch (error) {
            if (this.config.logPayloads) {
                console.error('[DiscordBridge] Presence poll failed:', error);
            }
        }
    }

    private getActivePresenceUrl(): string {
        return String(this.runtimePresenceUrl || this.config.presenceUrl || '').trim();
    }

    private getActiveCharacterName(): string {
        return String(this.runtimeCharacterName || this.config.characterName || '').trim();
    }

    private buildJoinUrl(): string {
        const explicitJoinUrl = String(this.runtimeJoinUrl || this.config.joinUrl || '').trim();
        if (explicitJoinUrl) {
            return explicitJoinUrl;
        }

        const activePresenceUrl = this.getActivePresenceUrl();
        if (!activePresenceUrl) {
            return '';
        }

        const url = new URL(activePresenceUrl);
        url.pathname = '/api/presence/discord-join';
        url.search = '';
        url.hash = '';
        return url.toString();
    }

    private normalizeUrl(value: unknown): string {
        const text = String(value ?? '').trim();
        if (!text) {
            return '';
        }

        try {
            return new URL(text).toString();
        } catch (_error) {
            return '';
        }
    }

    private async subscribeToDiscordEvents(): Promise<void> {
        if (!this.client || !this.ready) {
            return;
        }

        try {
            await this.client.subscribe('ACTIVITY_JOIN');
        } catch (error) {
            if (this.config.logPayloads) {
                console.error('[DiscordBridge] Failed to subscribe to ACTIVITY_JOIN:', error);
            }
        }

        try {
            await this.client.subscribe('ACTIVITY_JOIN_REQUEST');
        } catch (error) {
            if (this.config.logPayloads) {
                console.error('[DiscordBridge] Failed to subscribe to ACTIVITY_JOIN_REQUEST:', error);
            }
        }
    }

    private async handleDiscordActivityJoin(data: unknown): Promise<void> {
        const joinSecret = this.extractJoinSecret(data);
        if (!joinSecret) {
            return;
        }

        const requesterName = String(this.currentPresence?.characterName ?? '').trim();
        if (!requesterName) {
            console.log('[DiscordBridge] Ignoring Discord join because no active character is selected locally.');
            return;
        }

        const joinUrl = this.buildJoinUrl();
        if (!joinUrl) {
            console.log('[DiscordBridge] Ignoring Discord join because no server join URL is configured.');
            return;
        }

        try {
            const response = await fetch(joinUrl, {
                method: 'POST',
                cache: 'no-store',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    secret: joinSecret,
                    requesterName
                })
            });
            const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
            if (!response.ok || !payload?.ok) {
                const message = String(payload?.message ?? `HTTP ${response.status}`).trim();
                console.log(`[DiscordBridge] Discord join failed for ${requesterName}: ${message}`);
                return;
            }

            console.log(`[DiscordBridge] Discord join accepted for ${requesterName}.`);
        } catch (error) {
            console.error('[DiscordBridge] Failed to process Discord join:', error);
        }
    }

    private async handleDiscordActivityJoinRequest(data: unknown): Promise<void> {
        const user = this.normalizeDiscordUser(data);
        if (!user || !this.client || !this.ready) {
            return;
        }

        const partyId = Number(this.currentPresence?.partyId ?? 0);
        const partySize = Number(this.currentPresence?.partySize ?? 0);
        const partyMax = Number(this.currentPresence?.partyMax ?? PARTY_MAX_MEMBERS);
        const joinSecret = String(this.currentPresence?.joinSecret ?? '').trim();
        const partyLocked = Boolean(this.currentPresence?.partyLocked);

        if (!partyId || !joinSecret || partyLocked || partySize >= partyMax) {
            try {
                await this.client.closeJoinRequest(user.id);
                console.log(`[DiscordBridge] Rejected Discord join request from ${user.label}.`);
            } catch (error) {
                console.error('[DiscordBridge] Failed to reject Discord join request:', error);
            }
            return;
        }

        try {
            await this.client.sendJoinInvite(user.id);
            console.log(`[DiscordBridge] Accepted Discord join request from ${user.label}.`);
        } catch (error) {
            console.error('[DiscordBridge] Failed to accept Discord join request:', error);
        }
    }

    private extractJoinSecret(data: unknown): string {
        if (!data || typeof data !== 'object') {
            return '';
        }

        const raw = data as Record<string, unknown>;
        return String(raw.secret ?? raw.joinSecret ?? '').trim();
    }

    private normalizeDiscordUser(data: unknown): { id: string; label: string } | null {
        if (!data || typeof data !== 'object') {
            return null;
        }

        const root = data as Record<string, unknown>;
        const candidate = root.user && typeof root.user === 'object'
            ? (root.user as Record<string, unknown>)
            : root;
        const id = String(candidate.id ?? candidate.user_id ?? '').trim();
        if (!id) {
            return null;
        }

        const username = String(candidate.username ?? candidate.global_name ?? candidate.name ?? '').trim();
        const discriminator = String(candidate.discriminator ?? '').trim();
        const suffix = discriminator && discriminator !== '0' ? `#${discriminator}` : '';

        return {
            id,
            label: username ? `${username}${suffix}` : id
        };
    }

    private async applyActivity(payload: PresencePayload): Promise<boolean> {
        if (!this.client || !this.ready) {
            return false;
        }

        const activity: Record<string, unknown> = {
            details: payload.details,
            state: payload.state,
            instance: false,
            startTimestamp: new Date(payload.startedAtMs ?? Date.now())
        };

        if ((payload.partyId ?? 0) > 0) {
            activity.partyId = String(payload.partyId);
            activity.partySize = payload.partySize;
            activity.partyMax = payload.partyMax ?? PARTY_MAX_MEMBERS;
        }

        if (payload.joinSecret) {
            activity.joinSecret = payload.joinSecret;
        }

        if (payload.disciplineKey) {
            activity.smallImageKey = payload.disciplineKey;
            activity.smallImageText = `${payload.characterName} - ${payload.characterClass}`;
        } else if (this.config.smallImageKey) {
            activity.smallImageKey = this.config.smallImageKey;
            if (this.config.smallImageText) {
                activity.smallImageText = this.config.smallImageText;
            }
        }

        const largeImageKey = payload.areaKey || this.resolveLargeImageKey(payload);
        if (largeImageKey) {
            activity.largeImageKey = largeImageKey;
            activity.largeImageText = payload.levelName || this.config.largeImageText;
        }

        // Add Buttons
        const buttons: any[] = [];
        const baseUrl = this.getActivePresenceUrl().split('/api/')[0];
        if (baseUrl) {
            buttons.push({ label: 'Play Game', url: baseUrl });
        }
        
        if (buttons.length > 0) {
            activity.buttons = buttons;
        }

        const nextHash = JSON.stringify(activity);
        if (nextHash === this.lastActivityHash) {
            return false;
        }

        try {
            const pid = this.updateTargetPid();
            await this.client.setActivity(activity, pid ?? undefined);
            this.lastActivityHash = nextHash;
            this.currentPresence = { ...payload };
            console.log(`[DiscordBridge] Presence updated: ${payload.characterName} | ${payload.details} | ${payload.state}` + (pid ? ` (PID: ${pid})` : ''));
            return true;
        } catch (error) {
            console.error('[DiscordBridge] Failed to update activity:', error);
            return false;
        }
    }

    private async clearActivity(): Promise<void> {
        if (!this.client || !this.ready || !this.lastActivityHash) {
            this.lastActivityHash = '';
            this.currentPresence = null;
            return;
        }

        try {
            const pid = this.updateTargetPid();
            await this.client.clearActivity(pid ?? undefined);
        } catch (error) {
            console.error('[DiscordBridge] Failed to clear activity:', error);
        } finally {
            this.lastActivityHash = '';
            this.currentPresence = null;
        }
    }

    private resolveLargeImageKey(payload: PresencePayload): string {
        const levelKey = String(payload.levelKey ?? '').trim();
        const activityKind = String(payload.activityKind ?? '').trim().toLowerCase();

        if (levelKey === 'CraftTown' || levelKey === 'CraftTownTutorial') {
            return this.config.largeImageHomeKey;
        }

        if (levelKey === 'NewbieRoad' || levelKey === 'NewbieRoadHard') {
            return this.config.largeImageNewbieRoadKey;
        }

        if (activityKind === 'dungeon') {
            return this.config.largeImageDungeonKey;
        }

        return '';
    }

    private updateTargetPid(): number | null {
        if (!this.config.targetProcessName) {
            return null;
        }

        try {
            const { execSync } = require('child_process');
            // Try pgrep -f first (full command line match)
            let output = '';
            try {
                output = execSync(`pgrep -f "${this.config.targetProcessName}"`, { encoding: 'utf8' }).trim();
            } catch {
                // Ignore pgrep failure (often happens if no match)
            }

            if (!output) {
                // Try ps as fallback
                try {
                    const psOutput = execSync(`ps aux | grep -v grep | grep -i "${this.config.targetProcessName}"`, { encoding: 'utf8' });
                    const lines = psOutput.trim().split('\n');
                    if (lines.length > 0) {
                        const parts = lines[0].trim().split(/\s+/);
                        if (parts.length > 1) {
                            output = parts[1];
                        }
                    }
                } catch {
                    // Ignore ps failure
                }
            }

            if (output) {
                const pid = parseInt(output.split('\n')[0], 10);
                if (Number.isFinite(pid) && pid > 0) {
                    if (this.targetPid !== pid) {
                        this.targetPid = pid;
                        console.log(`[DiscordBridge] Linked presence to process "${this.config.targetProcessName}" (PID: ${pid})`);
                    }
                    return pid;
                }
            }
        } catch (error) {
            if (this.config.logPayloads) {
                console.error('[DiscordBridge] PID discovery failed:', error);
            }
        }

        if (this.targetPid !== null) {
            this.targetPid = null;
            console.log(`[DiscordBridge] Process "${this.config.targetProcessName}" no longer found.`);
        }
        return null;
    }
}

function readConfig(): BridgeConfig {
    const defaults: BridgeConfig = {
        appId: '',
        port: DEFAULT_PORT,
        presenceUrl: buildLocalPresenceEndpoint('/api/presence/discord-target'),
        joinUrl: '',
        characterName: '',
        pollMs: 4000,
        largeImageText: 'Dungeon Blitz: R',
        smallImageKey: 'dungeon_blitz',
        smallImageText: 'Dungeon Blitz: R',
        largeImageHomeKey: 'home',
        largeImageDungeonKey: 'indungeon',
        largeImageNewbieRoadKey: 'newbieroad',
        logPayloads: false,
        targetProcessName: ''
    };

    if (!fs.existsSync(CONFIG_PATH)) {
        return defaults;
    }

    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
    return {
        appId: String(raw.appId ?? defaults.appId).trim(),
        port: Number.isFinite(Number(raw.port)) ? Math.max(1, Math.round(Number(raw.port))) : defaults.port,
        presenceUrl: preferLocalDevUrl(
            String(raw.presenceUrl ?? defaults.presenceUrl).trim(),
            '/api/presence/discord-target'
        ),
        joinUrl: preferLocalDevUrl(
            String(raw.joinUrl ?? defaults.joinUrl).trim(),
            '/api/presence/discord-join'
        ),
        characterName: String(raw.characterName ?? defaults.characterName).trim(),
        pollMs: Number.isFinite(Number(raw.pollMs)) ? Math.max(1000, Math.round(Number(raw.pollMs))) : defaults.pollMs,
        largeImageText: String(raw.largeImageText ?? defaults.largeImageText).trim(),
        smallImageKey: String(raw.smallImageKey ?? defaults.smallImageKey).trim(),
        smallImageText: String(raw.smallImageText ?? defaults.smallImageText).trim(),
        largeImageHomeKey: String(raw.largeImageHomeKey ?? defaults.largeImageHomeKey).trim(),
        largeImageDungeonKey: String(raw.largeImageDungeonKey ?? defaults.largeImageDungeonKey).trim(),
        largeImageNewbieRoadKey: String(raw.largeImageNewbieRoadKey ?? defaults.largeImageNewbieRoadKey).trim(),
        logPayloads: Boolean(raw.logPayloads),
        targetProcessName: String(raw.targetProcessName ?? defaults.targetProcessName).trim()
    };
}

async function main(): Promise<void> {
    const bridge = new LocalDiscordBridge(readConfig());
    await bridge.start();
}

void main();
