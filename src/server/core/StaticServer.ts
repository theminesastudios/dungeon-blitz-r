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
import { DiscordAccountLinkService } from '../integrations/DiscordAccountLinkService';
import { JsonAdapter } from '../database/JsonAdapter';
import { UserAccount } from '../database/Database';
import { hashPassword, isValidRegistrationPassword, normalizeAccountIdentifier } from '../auth/PasswordAuth';
import { LoginHandler } from '../handlers/LoginHandler';

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

function escapeHtml(value: string | null | undefined): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export class StaticServer {
    private app: express.Application;
    private server: HttpServer | null;
    private port: number;
    private contentDir: string;
    private host: string;
    private selectedSwfCache: { key: string; buffer: Buffer } | null;
    private readonly discordAccountLinks: DiscordAccountLinkService;
    private readonly db: JsonAdapter;
    private readonly selectedAssetVersion = 'cbp';
    private readonly flashVersion = this.selectedAssetVersion;
    private readonly gameVersion = this.selectedAssetVersion;

    private static shouldLog(): boolean {
        return process.env.DEBUG_STATIC_SERVER === '1';
    }

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
        this.discordAccountLinks = new DiscordAccountLinkService();
        this.db = new JsonAdapter();
        
        // Resolve against the server root so dist and ts-node use the same content directory.
        this.contentDir = resolveContentDir(relativeContentPath);
        
        this.setupRoutes();
    }

    private getSelectedSwfPath(): string {
        return path.join(this.contentDir, 'p', this.selectedAssetVersion, 'DungeonBlitz.swf');
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
        if (StaticServer.shouldLog()) {
            console.log(`[StaticServer] Prepared DungeonBlitz.swf variant for ${mode} mode (${locale}).`);
        }
        return buffer;
    }

    private getSelectedSwfUrl(): string {
        return `/p/${this.selectedAssetVersion}/DungeonBlitz.swf?fv=${this.flashVersion}&gv=${this.gameVersion}`;
    }

    private getCanonicalSelectedSwfUrl(req?: Request): string {
        const params = new URLSearchParams();
        params.set('fv', this.flashVersion);
        params.set('gv', this.gameVersion);

        if (req) {
            for (const [key, rawValue] of Object.entries(req.query)) {
                if (key === 'fv' || key === 'gv') {
                    continue;
                }

                const values = Array.isArray(rawValue) ? rawValue : [rawValue];
                for (const value of values) {
                    if (value === undefined || value === null || typeof value === 'object') {
                        continue;
                    }
                    params.append(key, String(value));
                }
            }
        }

        return `/p/${this.selectedAssetVersion}/DungeonBlitz.swf?${params.toString()}`;
    }

    private isCanonicalSelectedSwfRequest(req: Request): boolean {
        return String(req.query.fv ?? '') === this.flashVersion &&
            String(req.query.gv ?? '') === this.gameVersion;
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

    private resolveRequesterAccountEmail(req: Request): string {
        const remoteAddress = this.normalizeRemoteAddress(this.resolveRequesterAddress(req));
        if (!remoteAddress) {
            return '';
        }

        const sessions = Array.from(GlobalState.sessionsByToken.values()).filter((client) => {
            return this.normalizeRemoteAddress(client.socket.remoteAddress) === remoteAddress;
        });
        const activeSessions = sessions.filter((client) => client.playerSpawned);
        const candidates = activeSessions.length > 0 ? activeSessions : sessions;
        const emails = new Set(
            candidates
                .map((client) => String(client.account?.email ?? '').trim().toLowerCase())
                .filter(Boolean)
        );

        return emails.size === 1 ? [...emails][0] ?? '' : '';
    }

    private async resolveRequesterAccount(req: Request): Promise<UserAccount | null> {
        const email = this.resolveRequesterAccountEmail(req);
        return email ? await this.db.getAccount(email) : null;
    }

    private async authenticateRequesterLoginClient(req: Request, account: UserAccount): Promise<boolean> {
        const remoteAddress = this.normalizeRemoteAddress(this.resolveRequesterAddress(req));
        if (!remoteAddress || !account.user_id) {
            return false;
        }

        const candidates = Array.from(GlobalState.clients).filter((client) =>
            this.normalizeRemoteAddress(client.socket.remoteAddress) === remoteAddress &&
            !client.authenticated &&
            !client.socket.destroyed &&
            client.socket.readyState === 'open'
        );
        const client = candidates[candidates.length - 1];
        if (!client) {
            return false;
        }

        client.userId = account.user_id;
        client.account = account;
        client.authenticated = true;
        client.characters = await this.db.loadCharacters(account.user_id);
        LoginHandler.sendCharacterList(client);
        console.log(`[DiscordOAuth] Authenticated active game client for ${account.email}`);
        return true;
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

    private getFlashVersionAssetPath(assetPath: string): string {
        const segments = assetPath.split('/').filter(Boolean);
        if (segments.some((segment) => segment === '..' || segment.includes(path.sep))) {
            return path.join(this.contentDir, 'p', this.flashVersion, '__invalid__');
        }
        const normalizedAssetPath = segments.join(path.sep);
        const versionedPath = path.join(this.contentDir, 'p', this.flashVersion, normalizedAssetPath);
        if (fs.existsSync(versionedPath)) {
            return versionedPath;
        }

        return path.join(this.contentDir, 'p', 'cbq', normalizedAssetPath);
    }

    private renderDevSettings(devSettingsPath: string): string {
        const contents = fs.readFileSync(devSettingsPath, 'utf8');
        return contents.replace(
            /value="(?:100\.100\.146\.54|127\.0\.0\.1|localhost)"/g,
            `value="${Config.HOST}"`
        );
    }

    private renderLostPasswordPage(message: string = '', isError: boolean = false): string {
        const resetEnabled = Config.ALLOW_DEV_PASSWORD_RESET;
        const statusClass = isError ? 'error' : 'success';
        const safeMessage = message
            ? `<p class="message ${statusClass}">${escapeHtml(message)}</p>`
            : '';
        const disabled = resetEnabled ? '' : 'disabled';
        const unavailable = resetEnabled
            ? ''
            : '<p class="message error">Password reset is not configured for this server mode.</p>';

        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dungeon Blitz Password Reset</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f2f4f7; color: #17202a; }
    main { width: min(420px, calc(100% - 32px)); margin: 48px auto; background: #fff; border: 1px solid #d7dde5; padding: 24px; }
    h1 { margin: 0 0 16px; font-size: 24px; }
    label { display: block; margin: 14px 0 6px; font-weight: 700; }
    input { box-sizing: border-box; width: 100%; padding: 10px; border: 1px solid #b7c0cc; font: inherit; }
    button { margin-top: 18px; width: 100%; padding: 10px 12px; border: 0; background: #1b5f8f; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    button:disabled { background: #8c98a6; cursor: not-allowed; }
    .message { padding: 10px; border: 1px solid; }
    .success { background: #e9f7ef; border-color: #8fd19e; }
    .error { background: #fdecea; border-color: #f0a29a; }
    .note { color: #536171; font-size: 13px; line-height: 1.4; }
  </style>
</head>
<body>
  <main>
    <h1>Password Reset</h1>
    ${unavailable}
    ${safeMessage}
    <form method="post" action="/lostpw" autocomplete="off">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required ${disabled}>
      <label for="password">New password</label>
      <input id="password" name="password" type="password" minlength="6" required ${disabled}>
      <label for="confirmPassword">Confirm new password</label>
      <input id="confirmPassword" name="confirmPassword" type="password" minlength="6" required ${disabled}>
      <button type="submit" ${disabled}>Reset password</button>
    </form>
    <p class="note">Local/dev reset only. Passwords are stored as salted hashes, never plaintext.</p>
  </main>
</body>
</html>`;
    }

    private renderDiscordOAuthPage(title: string, message: string, isError: boolean = false): string {
        const statusClass = isError ? 'error' : 'success';
        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f2f4f7; color: #17202a; }
    main { width: min(520px, calc(100% - 32px)); margin: 48px auto; background: #fff; border: 1px solid #d7dde5; padding: 24px; }
    h1 { margin: 0 0 16px; font-size: 24px; }
    .message { padding: 10px; border: 1px solid; line-height: 1.45; }
    .success { background: #e9f7ef; border-color: #8fd19e; }
    .error { background: #fdecea; border-color: #f0a29a; }
    a { color: #1b5f8f; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p class="message ${statusClass}">${escapeHtml(message)}</p>
    <p><a href="/">Return to the game</a></p>
  </main>
</body>
</html>`;
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
        this.app.use(express.urlencoded({ extended: false, limit: '16kb' }));

        this.app.use((req, res, next) => {
            const shouldLog =
                req.path === '/' ||
                req.path.endsWith('.swf') ||
                req.path.endsWith('.swz') ||
                req.path.endsWith('.xml');

            if (shouldLog && StaticServer.shouldLog()) {
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

        this.app.get('/lostpw', (req, res) => {
            console.log(`[LostPassword] Page opened from ${this.normalizeRemoteAddress(this.resolveRequesterAddress(req)) || '-'}`);
            res.setHeader('Cache-Control', 'no-store');
            res.type('text/html').send(this.renderLostPasswordPage());
        });

        this.app.post('/lostpw', async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
            const email = normalizeAccountIdentifier(body.email);
            const password = typeof body.password === 'string' ? body.password : '';
            const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';

            console.log(`[LostPassword] Reset attempted for ${email || '(missing account id)'}`);

            if (!Config.ALLOW_DEV_PASSWORD_RESET) {
                console.warn(`[LostPassword] Reset rejected for ${email || '(missing account id)'}: reset disabled`);
                res.status(403).type('text/html').send(
                    this.renderLostPasswordPage('Password reset is not configured for this server mode.', true)
                );
                return;
            }

            if (!email || !isValidRegistrationPassword(password) || password !== confirmPassword) {
                console.warn(`[LostPassword] Reset failed for ${email || '(missing account id)'}: invalid form`);
                res.status(400).type('text/html').send(
                    this.renderLostPasswordPage('Could not reset password. Check the form fields and try again.', true)
                );
                return;
            }

            const account = await this.db.updateAccountPassword(email, await hashPassword(password));
            if (!account) {
                console.warn(`[LostPassword] Reset failed for ${email}: account not found`);
                res.status(400).type('text/html').send(
                    this.renderLostPasswordPage('Could not reset password. Check the form fields and try again.', true)
                );
                return;
            }

            console.log(`[LostPassword] Reset succeeded for ${email}`);
            res.type('text/html').send(
                this.renderLostPasswordPage('Password reset complete. You can return to the game and log in.', false)
            );
        });

        this.app.get('/api/auth/discord/config', async (req, res) => {
            const requesterAccount = await this.resolveRequesterAccount(req);
            res.setHeader('Cache-Control', 'no-store');
            res.json({
                configured: this.discordAccountLinks.isConfigured(),
                authUrl: '/auth/discord',
                linkUrl: requesterAccount ? '/auth/discord?mode=link' : null,
                mode: requesterAccount ? 'link' : 'login',
                redirectUri: this.discordAccountLinks.getRedirectUri()
            });
        });

        this.app.get('/auth/discord', async (req, res) => {
            if (!this.discordAccountLinks.isConfigured()) {
                console.warn('[DiscordOAuth] Start rejected: not configured');
                res.status(503).type('text/html').send(
                    this.renderDiscordOAuthPage(
                        'Discord Login Disabled',
                        'Discord OAuth is not configured on this server.',
                        true
                    )
                );
                return;
            }

            const requesterAccount = await this.resolveRequesterAccount(req);
            const requestedMode = String(req.query.mode ?? '').trim().toLowerCase();
            const useLinkMode = Boolean(requesterAccount && (requestedMode === 'link' || requesterAccount));
            const result = useLinkMode && requesterAccount
                ? await this.discordAccountLinks.createLinkAuthorizeUrlForAccount(requesterAccount)
                : await this.discordAccountLinks.createLoginAuthorizeUrl();

            if (!result.ok || !result.authorizeUrl) {
                console.warn(`[DiscordOAuth] Start failed: ${result.reason}`);
                res.status(result.reason === 'not-configured' ? 503 : 400).type('text/html').send(
                    this.renderDiscordOAuthPage('Discord Login Failed', result.message ?? 'Discord login could not start.', true)
                );
                return;
            }

            console.log(`[DiscordOAuth] Starting ${useLinkMode ? 'link' : 'login'} flow`);
            res.redirect(result.authorizeUrl);
        });

        this.app.get('/auth/discord/callback', async (req, res) => {
            const discordError = String(req.query.error ?? '').trim();
            if (discordError) {
                console.warn(`[DiscordOAuth] Callback failed: ${discordError}`);
                res.status(400).type('text/html').send(
                    this.renderDiscordOAuthPage('Discord Login Cancelled', 'Discord authorization did not complete.', true)
                );
                return;
            }

            const code = String(req.query.code ?? '').trim();
            const state = String(req.query.state ?? '').trim();
            const result = await this.discordAccountLinks.completeOAuth(code, state);
            if (!result.ok || !result.account) {
                console.warn(`[DiscordOAuth] Callback rejected: ${result.reason}`);
                const status = result.reason === 'not-linked' ? 409 : 400;
                res.status(status).type('text/html').send(
                    this.renderDiscordOAuthPage(
                        result.reason === 'not-linked' ? 'Discord Account Not Linked' : 'Discord Login Failed',
                        result.message ?? 'Discord login failed.',
                        true
                    )
                );
                return;
            }

            if (result.mode === 'link') {
                console.log(`[DiscordOAuth] Linked Discord account to ${result.account.email}`);
                res.type('text/html').send(
                    this.renderDiscordOAuthPage('Discord Linked', 'Discord linked successfully. Return to the game.')
                );
                return;
            }

            const didAuthenticateClient = await this.authenticateRequesterLoginClient(req, result.account);
            console.log(`[DiscordOAuth] Login succeeded for ${result.account.email}; activeClient=${didAuthenticateClient}`);
            res.type('text/html').send(
                this.renderDiscordOAuthPage(
                    'Discord Login Successful',
                    didAuthenticateClient
                        ? 'Discord login successful. Return to the game.'
                        : 'Discord login successful. Return to the game; if it did not update, reopen the game login screen and try again.'
                )
            );
        });

        this.app.get(`/p/${this.selectedAssetVersion}/DungeonBlitz.swf`, (req, res) => {
            if (!this.isCanonicalSelectedSwfRequest(req)) {
                res.redirect(302, this.getCanonicalSelectedSwfUrl(req));
                return;
            }

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

        this.app.get('/p/:assetVersion/Game.swz', (req, res) => {
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

        this.app.use(`/p/${this.flashVersion}`, (req, res, next) => {
            const assetPath = this.getFlashVersionAssetPath(req.path);
            if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
                next();
                return;
            }

            if (assetPath.endsWith('.xml')) {
                res.type('application/xml');
            }
            res.sendFile(assetPath);
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

        this.app.get('/discord/link', async (req, res) => {
            const requestedEmail = String(req.query.email ?? '').trim() || this.resolveRequesterAccountEmail(req);
            const result = await this.discordAccountLinks.createAuthorizeUrl(requestedEmail);
            if (result.ok && result.reason === 'already-linked' && result.link) {
                const discordName = result.link.discordGlobalName || result.link.discordUsername || result.link.discordId || 'Discord';
                res.type('text/html').send(
                    `<h1>Discord already linked</h1><p>${escapeHtml(discordName)} is already linked to ${escapeHtml(result.link.email)}.</p>`
                );
                return;
            }

            if (!result.ok || !result.authorizeUrl) {
                res.status(result.reason === 'not-configured' ? 503 : 400).type('text/plain').send(result.message ?? result.reason);
                return;
            }

            res.redirect(result.authorizeUrl);
        });

        this.app.get('/api/discord/link/start', async (req, res) => {
            const requestedEmail = String(req.query.email ?? '').trim() || this.resolveRequesterAccountEmail(req);
            const result = await this.discordAccountLinks.createAuthorizeUrl(requestedEmail);
            const statusCode = result.ok ? 200 : result.reason === 'not-configured' ? 503 : 400;

            res.setHeader('Cache-Control', 'no-store');
            if (result.ok && result.reason === 'already-linked' && result.link) {
                res.status(200).json({
                    ok: true,
                    reason: result.reason,
                    message: result.message,
                    link: {
                        email: result.link.email,
                        userId: result.link.user_id,
                        discordId: result.link.discordId,
                        discordUsername: result.link.discordUsername,
                        discordGlobalName: result.link.discordGlobalName,
                        discordLinkedAt: result.link.discordLinkedAt
                    }
                });
                return;
            }

            if (result.ok && result.authorizeUrl && req.query.redirect === '1') {
                res.redirect(result.authorizeUrl);
                return;
            }

            res.status(statusCode).json(result);
        });

        this.app.get('/api/discord/link/callback', async (req, res) => {
            const code = String(req.query.code ?? '').trim();
            const state = String(req.query.state ?? '').trim();
            const result = await this.discordAccountLinks.completeLink(code, state);
            const statusCode = result.ok ? 200 : 400;

            res.setHeader('Cache-Control', 'no-store');
            if (!result.ok || !result.account) {
                res.status(statusCode).type('text/html').send(
                    `<h1>Discord link failed</h1><p>${escapeHtml(result.message ?? result.reason)}</p>`
                );
                return;
            }

            const discordName =
                result.discordUser?.globalName ||
                result.discordUser?.username ||
                result.discordUser?.id ||
                result.account.discordGlobalName ||
                result.account.discordUsername ||
                result.account.discordId ||
                'Discord';
            res.type('text/html').send(
                `<h1>Discord linked</h1><p>${escapeHtml(discordName)} is now linked to ${escapeHtml(result.account.email)}.</p>`
            );
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
            console.log(`[StaticServer] Password reset URL: ${Config.PASSWORD_RESET_URL}`);
            console.log(
                `[StaticServer] Discord OAuth login: ${this.discordAccountLinks.isConfigured() ? 'configured' : 'disabled'}`
            );
            if (StaticServer.shouldLog()) {
                const portSuffix = this.port === 80 ? '' : `:${this.port}`;
                const baseUrl = `http://${Config.HOST}${portSuffix}`;
                console.log(`[StaticServer] Serving ${this.contentDir} on http://${this.host}:${this.port}`);
                console.log(`[StaticServer] Multiplayer mode: ${Config.MULTIPLAYER_MODE}`);
                console.log(`[StaticServer] Browser URL: ${baseUrl}/`);
                console.log(`[StaticServer] Flash URL: ${baseUrl}${this.getSelectedSwfUrl()}`);
            }
        });

        this.server.on('error', (error) => {
            const socketError = error as NodeJS.ErrnoException;
            if (socketError.code === 'EADDRINUSE') {
                console.error(
                    `[Server] Cannot listen on ${this.host}:${this.port} because the port is already in use.`
                );
                console.error('[Server] Stop the previous dev server or change STATIC_PORT before restarting.');
                process.exitCode = 1;
                setImmediate(() => process.exit(1));
                return;
            }

            console.error('[Server] Static server error:', error);
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
