import express from 'express';
import * as fs from 'fs';
import type { Server as HttpServer } from 'http';
import * as path from 'path';
import type { Request } from 'express';
import { Config } from './config';
import { buildDungeonBlitzSwfVariantBuffer, type DungeonBlitzSwfLocale } from './DungeonBlitzSwf';
import { PresenceService } from './PresenceService';
import { SocialHandler } from '../handlers/SocialHandler';
import { GlobalState } from './GlobalState';

function resolveContentDir(relativeContentPath: string): string {
    const candidates = [
        path.resolve(Config.DATA_DIR, relativeContentPath),
        path.resolve(__dirname, relativeContentPath),
        path.resolve(process.cwd(), relativeContentPath),
        path.resolve(process.cwd(), '../client/content/localhost'),
        path.resolve(process.cwd(), 'src/client/content/localhost')
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'index.html'))) {
            return candidate;
        }
    }

    return candidates[0];
}

export class StaticServer {
    private app: express.Application;
    private server: HttpServer | null;
    private port: number;
    private contentDir: string;
    private host: string;
    private selectedSwfCache: { key: string; buffer: Buffer } | null;
    private readonly flashVersion = 'cbq';
    private readonly gameVersion = 'cbp';
    private readonly runtimeVersion = '20260517-class82-scene-cache-safe';

    constructor(
        port: number = Config.STATIC_PORT,
        relativeContentPath: string = '../client/content/localhost',
        host: string = Config.BIND_HOST
    ) {
        this.port = port;
        this.host = host;
        this.app = express();
        this.server = null;
        this.selectedSwfCache = null;
        
        // Resolve against the server root so dist and ts-node use the same content directory.
        this.contentDir = resolveContentDir(relativeContentPath);
        
        this.setupRoutes();
    }

    private getSelectedSwfPath(): string {
        return path.join(this.contentDir, 'p', 'cbp', 'DungeonBlitz.swf');
    }

    private getSelectedSwfBuffer(locale: DungeonBlitzSwfLocale): Buffer {
        const mode = Config.MULTIPLAYER_MODE ? 'multiplayer' : 'local';
        const swfPath = this.getSelectedSwfPath();
        const stats = fs.statSync(swfPath);
        const cacheKey = `${mode}:${locale}:${swfPath}:${stats.mtimeMs}:${stats.size}`;
        if (this.selectedSwfCache?.key === cacheKey) {
            return this.selectedSwfCache.buffer;
        }

        const buffer = buildDungeonBlitzSwfVariantBuffer(swfPath, mode, locale);
        this.selectedSwfCache = { key: cacheKey, buffer };
        console.log(`[StaticServer] Prepared DungeonBlitz.swf variant for ${mode} mode (${locale}).`);
        return buffer;
    }

    private getSelectedSwfUrl(): string {
        return `/p/cbp/DungeonBlitz.swf?fv=${this.flashVersion}&gv=${this.gameVersion}&rv=${this.runtimeVersion}`;
    }

    private normalizeLocale(value: unknown): 'en' | 'tr' | null {
        const normalized = String(value ?? '').trim().toLowerCase();
        return normalized === 'en' || normalized === 'tr' ? normalized : null;
    }

    private normalizeRemoteAddress(value: string | null | undefined): string {
        const address = String(value ?? '').trim();
        if (!address) {
            return '';
        }
        if (address.startsWith('::ffff:')) {
            return address.slice('::ffff:'.length);
        }
        return address === '::1' ? '127.0.0.1' : address;
    }

    private resolveSessionLocale(req: Request): 'en' | 'tr' | null {
        const remoteAddress = this.normalizeRemoteAddress(this.resolveRequesterAddress(req));
        if (!remoteAddress) {
            return null;
        }

        const sessions = Array.from(GlobalState.sessionsByToken.values()).filter((client) => {
            return this.normalizeRemoteAddress(client.socket.remoteAddress) === remoteAddress;
        });
        const activeSessions = sessions.filter((client) => client.playerSpawned);
        const candidates = activeSessions.length > 0 ? activeSessions : sessions;
        const locales = new Set(
            candidates
                .map((client) => this.normalizeLocale(client.character?.dialogueLanguage))
                .filter((locale): locale is 'en' | 'tr' => Boolean(locale))
        );

        return locales.size === 1 ? [...locales][0] ?? null : null;
    }

    private resolveGameSwzLocale(req: Request): 'en' | 'tr' {
        return (
            this.normalizeLocale(req.query.lang) ??
            this.resolveSessionLocale(req) ??
            'en'
        );
    }

    private resolveSwfLocale(req: Request): DungeonBlitzSwfLocale {
        return (
            this.normalizeLocale(req.query.lang) ??
            this.resolveSessionLocale(req) ??
            'en'
        );
    }

    private getGameSwzPathForLocale(locale: 'en' | 'tr'): string {
        const cbqDir = path.join(this.contentDir, 'p', 'cbq');
        const variantPath = path.join(cbqDir, `Game.${locale}.swz`);
        if (fs.existsSync(variantPath)) {
            return variantPath;
        }

        if (locale === 'en') {
            const backupPath = path.join(cbqDir, 'Game.swz.bak');
            if (fs.existsSync(backupPath)) {
                return backupPath;
            }
        }

        return path.join(cbqDir, 'Game.swz');
    }

    private renderDevSettings(devSettingsPath: string): string {
        const contents = fs.readFileSync(devSettingsPath, 'utf8');
        return contents.replace(
            /value="(?:100\.100\.146\.54|127\.0\.0\.1|localhost)"/g,
            `value="${Config.HOST}"`
        );
    }

    private resolveRequesterAddress(req: Request): string {
        const forwardedFor = req.headers['x-forwarded-for'];
        if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
            return forwardedFor.split(',')[0]?.trim() ?? '';
        }

        if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
            return String(forwardedFor[0] ?? '').trim();
        }

        return req.socket.remoteAddress ?? '';
    }

    private setupRoutes(): void {
        const devSettingsPath = path.join(this.contentDir, 'p', 'cbq', 'devSettings.xml');

        this.app.use(express.json({ limit: '64kb' }));

        this.app.use((req, res, next) => {
            const shouldLog =
                req.path === '/' ||
                req.path.endsWith('.swf') ||
                req.path.endsWith('.swz') ||
                req.path.endsWith('.xml');

            if (shouldLog) {
                const remoteAddress = req.socket.remoteAddress ?? '-';
                const startedAt = Date.now();
                let finished = false;
                console.log(`[StaticServer] -> ${req.method} ${req.path} from ${remoteAddress}`);
                res.on('finish', () => {
                    finished = true;
                    console.log(
                        `[StaticServer] <- ${res.statusCode} ${req.method} ${req.path} to ${remoteAddress} ${Date.now() - startedAt}ms`
                    );
                });
                res.on('close', () => {
                    if (!finished) {
                        console.log(
                            `[StaticServer] xx ${req.method} ${req.path} to ${remoteAddress} closed after ${Date.now() - startedAt}ms`
                        );
                    }
                });
            }

            if (req.path.endsWith('.swf') || req.path.endsWith('.swz')) {
                res.type('application/x-shockwave-flash');
            }

            if (
                req.path === '/' ||
                req.path.endsWith('.swf') ||
                req.path.endsWith('.swz') ||
                req.path.endsWith('.xml')
            ) {
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
                res.setHeader('Surrogate-Control', 'no-store');
                res.setHeader('Connection', 'close');
            }
            next();
        });

        this.app.get('/', (_req, res) => {
            res.sendFile(path.join(this.contentDir, 'index.html'));
        });

        this.app.get('/p/cbp/DungeonBlitz.swf', (req, res) => {
            const locale = this.resolveSwfLocale(req);
            res.type('application/x-shockwave-flash');
            res.setHeader('X-DungeonBlitz-Language', locale);
            res.send(this.getSelectedSwfBuffer(locale));
        });

        this.app.get('/p/cbq/Game.swz', (req, res) => {
            const locale = this.resolveGameSwzLocale(req);
            const swzPath = this.getGameSwzPathForLocale(locale);
            res.type('application/x-shockwave-flash');
            res.setHeader('X-DungeonBlitz-Language', locale);
            res.sendFile(swzPath);
        });

        this.app.get('/DungeonBlitzRemote.swf', (req, res) => {
            const locale = this.resolveSwfLocale(req);
            res.type('application/x-shockwave-flash');
            res.setHeader('X-DungeonBlitz-Language', locale);
            res.send(this.getSelectedSwfBuffer(locale));
        });

        this.app.get('/p/cbq/devSettings.xml', (_req, res) => {
            res.type('application/xml');
            res.send(this.renderDevSettings(devSettingsPath));
        });

        this.app.get('/api/presence/sessions', (req, res) => {
            const requestedCharacter = String(req.query.character ?? '').trim();
            const sessions = PresenceService.listSessions().filter((session) => {
                if (!requestedCharacter) {
                    return true;
                }
                return session.characterName.localeCompare(requestedCharacter, undefined, { sensitivity: 'accent' }) === 0;
            });

            res.setHeader('Cache-Control', 'no-store');
            res.json({
                serverTime: new Date().toISOString(),
                count: sessions.length,
                sessions
            });
        });

        this.app.get('/api/presence/discord-target', (req, res) => {
            const requestedCharacter = String(req.query.character ?? '').trim();
            const selection = PresenceService.selectDiscordTarget(requestedCharacter);
            const statusCode =
                selection.reason === 'ok' ? 200 : selection.reason === 'ambiguous' ? 409 : 404;

            res.setHeader('Cache-Control', 'no-store');
            res.status(statusCode).json({
                serverTime: new Date().toISOString(),
                reason: selection.reason,
                availableCharacters: selection.availableCharacters,
                session: selection.snapshot
            });
        });

        this.app.get('/api/presence/self', (req, res) => {
            const selection = PresenceService.selectRequesterSession(this.resolveRequesterAddress(req));
            const statusCode =
                selection.reason === 'ok' ? 200 : selection.reason === 'ambiguous' ? 409 : 404;

            res.setHeader('Cache-Control', 'no-store');
            res.status(statusCode).json({
                serverTime: new Date().toISOString(),
                reason: selection.reason,
                remoteAddress: selection.remoteAddress,
                availableCharacters: selection.availableCharacters,
                session: selection.snapshot
            });
        });

        this.app.post('/api/presence/discord-join', (req, res) => {
            const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
            const secret = String(body.secret ?? '').trim();
            const requesterName = String(body.requesterName ?? '').trim();
            const decodedSecret = PresenceService.resolveDiscordJoinSecret(secret);

            if (!decodedSecret) {
                res.status(400).json({
                    ok: false,
                    reason: 'invalid-secret',
                    message: 'Invalid Discord join secret.'
                });
                return;
            }

            const resolvedRequesterName =
                requesterName ||
                PresenceService.selectRequesterSession(this.resolveRequesterAddress(req)).snapshot?.characterName ||
                '';

            if (!resolvedRequesterName) {
                res.status(404).json({
                    ok: false,
                    reason: 'requester-not-found',
                    message: 'Could not resolve an online character for this Discord join.'
                });
                return;
            }

            const result = SocialHandler.joinPartyFromDiscord(
                resolvedRequesterName,
                decodedSecret.partyId,
                decodedSecret.partyLeader
            );
            const statusCode = result.ok ? 200 : result.reason === 'party-not-found' ? 404 : 409;

            res.setHeader('Cache-Control', 'no-store');
            res.status(statusCode).json({
                ok: result.ok,
                reason: result.reason,
                message: result.message,
                partyId: result.partyId
            });
        });

        // Serve static files
        this.app.use(express.static(this.contentDir, { index: false }));

        this.app.get('/healthz', (_req, res) => {
            res.type('text/plain');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Connection', 'close');
            res.send('ok');
        });
        
        // Debug route to check path
        this.app.get('/debug-path', (req, res) => {
            res.send(`Serving content from: ${this.contentDir}`);
        });
    }

    public start(): void {
        this.server = this.app.listen(this.port, this.host, () => {
            const portSuffix = this.port === 80 ? '' : `:${this.port}`;
            const baseUrl = `http://${Config.HOST}${portSuffix}`;
            console.log(`[StaticServer] Serving ${this.contentDir} on http://${this.host}:${this.port}`);
            console.log(`[StaticServer] Multiplayer mode: ${Config.MULTIPLAYER_MODE}`);
            console.log(`[StaticServer] Browser URL: ${baseUrl}/`);
            console.log(`[StaticServer] Flash URL: ${baseUrl}${this.getSelectedSwfUrl()}`);
        });

        this.server.on('error', (error) => {
            const socketError = error as NodeJS.ErrnoException;
            if (socketError.code === 'EADDRINUSE') {
                console.error(
                    `[StaticServer] Cannot listen on ${this.host}:${this.port} because the port is already in use.`
                );
                console.error('[StaticServer] Stop the previous dev server or change STATIC_PORT before restarting.');
                process.exitCode = 1;
                setImmediate(() => process.exit(1));
                return;
            }

            console.error('[StaticServer] Server error:', error);
        });
    }

    public stop(): Promise<void> {
        if (!this.server || !this.server.listening) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            this.server?.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    }
}
