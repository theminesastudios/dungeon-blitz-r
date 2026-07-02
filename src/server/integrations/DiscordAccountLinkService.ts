import * as crypto from 'crypto';

import { Config } from '../core/config';
import { DiscordAccountProfile, UserAccount } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';

interface DiscordOAuthStatePayload {
    mode: 'login' | 'link';
    email?: string;
    userId?: number;
    expiresAt: number;
    nonce: string;
}

interface DiscordTokenResponse {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
}

interface DiscordApiUser {
    id?: string;
    username?: string;
    global_name?: string | null;
    email?: string | null;
    verified?: boolean | null;
    avatar?: string | null;
}

export interface DiscordLinkStartResult {
    ok: boolean;
    reason: string;
    authorizeUrl?: string;
    link?: UserAccount;
    message?: string;
}

export interface DiscordOAuthCompleteResult {
    ok: boolean;
    reason: string;
    mode: 'login' | 'link';
    account?: UserAccount;
    discordUser?: DiscordAccountProfile;
    message?: string;
}

export type DiscordLinkCompleteResult = DiscordOAuthCompleteResult;

function base64UrlEncode(value: string | Buffer): string {
    return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value: string): string {
    return Buffer.from(value, 'base64url').toString('utf8');
}

function normalizeEmail(email: string | null | undefined): string {
    return String(email ?? '').trim().toLowerCase();
}

function normalizeDiscordId(value: string | null | undefined): string {
    return String(value ?? '').trim();
}

function toDiscordOAuthFailure(
    reason: string,
    mode: 'login' | 'link',
    discordUser: DiscordAccountProfile | undefined,
    message: string
): DiscordOAuthCompleteResult {
    return {
        ok: false,
        reason,
        mode,
        discordUser,
        message
    };
}

export function deriveDiscordAccountEmail(discordEmail: string, discordId: string): string {
    const normalizedEmail = normalizeEmail(discordEmail);
    const normalizedDiscordId = normalizeDiscordId(discordId).replace(/[^a-zA-Z0-9_-]/g, '');
    const atIndex = normalizedEmail.lastIndexOf('@');
    if (atIndex <= 0 || atIndex >= normalizedEmail.length - 1 || !normalizedDiscordId) {
        return '';
    }

    const localPart = normalizedEmail
        .slice(0, atIndex)
        .replace(/[^a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]/g, '_') || 'discord';
    const domain = normalizedEmail
        .slice(atIndex + 1)
        .replace(/[^a-zA-Z0-9.-]/g, '')
        .toLowerCase();

    return domain ? `${localPart}+discord-${normalizedDiscordId}@${domain}`.toLowerCase() : '';
}

export function normalizeDiscordUser(discordUser: DiscordApiUser | null | undefined): DiscordAccountProfile | null {
    const id = String(discordUser?.id ?? '').trim();
    if (!id) {
        return null;
    }

    return {
        id,
        username: String(discordUser?.username ?? '').trim(),
        globalName: String(discordUser?.global_name ?? '').trim(),
        displayName: String(discordUser?.global_name || discordUser?.username || '').trim(),
        email: normalizeEmail(discordUser?.email ?? ''),
        emailVerified: discordUser?.verified === true,
        avatar: String(discordUser?.avatar ?? '').trim()
    };
}

export class DiscordAccountLinkService {
    private readonly db = new JsonAdapter();
    private readonly appId: string;
    private readonly clientSecret: string;
    private readonly redirectUri: string;
    private readonly stateSecret: string;

    constructor() {
        this.appId = Config.DISCORD_CLIENT_ID;
        this.clientSecret = Config.DISCORD_CLIENT_SECRET;
        this.redirectUri = Config.DISCORD_REDIRECT_URI;
        this.stateSecret = String(process.env.DISCORD_ACCOUNT_LINK_STATE_SECRET ?? Config.SECRET).trim();
    }

    public isConfigured(): boolean {
        return Boolean(this.appId && this.clientSecret && this.redirectUri && this.stateSecret);
    }

    public getRedirectUri(): string {
        return this.redirectUri;
    }

    public async createLoginAuthorizeUrl(): Promise<DiscordLinkStartResult> {
        return this.createAuthorizeUrlForState({ mode: 'login' });
    }

    public async createLinkAuthorizeUrlForAccount(account: UserAccount): Promise<DiscordLinkStartResult> {
        return this.createAuthorizeUrlForState({
            mode: 'link',
            email: normalizeEmail(account.email),
            userId: account.user_id
        });
    }

    public async createAuthorizeUrl(email: string): Promise<DiscordLinkStartResult> {
        if (!this.isConfigured()) {
            return {
                ok: false,
                reason: 'not-configured',
                message: 'Discord OAuth requires DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI.'
            };
        }

        const normalizedEmail = normalizeEmail(email);
        if (!normalizedEmail) {
            return {
                ok: false,
                reason: 'missing-email',
                message: 'Missing game account email.'
            };
        }

        const account = await this.db.getAccount(normalizedEmail);
        if (!account) {
            return {
                ok: false,
                reason: 'account-not-found',
                message: 'No game account exists for that email.'
            };
        }

        if (account.discordId) {
            return {
                ok: true,
                reason: 'already-linked',
                link: account,
                message: 'Discord account is already linked.'
            };
        }

        return this.createLinkAuthorizeUrlForAccount(account);
    }

    public async completeLink(code: string, state: string): Promise<DiscordLinkCompleteResult> {
        return this.completeOAuth(code, state);
    }

    public async completeOAuth(code: string, state: string): Promise<DiscordOAuthCompleteResult> {
        if (!this.isConfigured()) {
            return {
                ok: false,
                reason: 'not-configured',
                mode: 'login',
                message: 'Discord OAuth is not configured.'
            };
        }

        const payload = this.verifyState(state);
        if (!payload) {
            return {
                ok: false,
                reason: 'invalid-state',
                mode: 'login',
                message: 'Discord OAuth state is invalid or expired.'
            };
        }

        const trimmedCode = String(code ?? '').trim();
        if (!trimmedCode) {
            return {
                ok: false,
                reason: 'missing-code',
                mode: payload.mode,
                message: 'Discord did not return an authorization code.'
            };
        }

        const token = await this.exchangeCode(trimmedCode);
        if (!token.access_token) {
            return {
                ok: false,
                reason: 'token-exchange-failed',
                mode: payload.mode,
                message: token.error_description || token.error || 'Discord token exchange failed.'
            };
        }

        const discordUser = normalizeDiscordUser(await this.fetchCurrentUser(token.access_token));
        if (!discordUser) {
            return {
                ok: false,
                reason: 'user-fetch-failed',
                mode: payload.mode,
                message: 'Could not fetch Discord user profile.'
            };
        }

        if (payload.mode === 'link') {
            return this.completeLinkMode(payload, discordUser);
        }

        return this.completeLoginMode(discordUser);
    }

    private requireVerifiedDiscordEmail(
        mode: 'login' | 'link',
        discordUser: DiscordAccountProfile
    ): DiscordOAuthCompleteResult | null {
        if (!normalizeEmail(discordUser.email)) {
            return toDiscordOAuthFailure(
                'missing-discord-email',
                mode,
                discordUser,
                'Discord did not provide an email address. Verify an email on Discord, then try again.'
            );
        }

        if (discordUser.emailVerified !== true) {
            return toDiscordOAuthFailure(
                'discord-email-unverified',
                mode,
                discordUser,
                'Discord email must be verified before a game account can be created or linked.'
            );
        }

        return null;
    }

    private async completeLoginMode(discordUser: DiscordAccountProfile): Promise<DiscordOAuthCompleteResult> {
        const emailFailure = this.requireVerifiedDiscordEmail('login', discordUser);
        if (emailFailure) {
            return emailFailure;
        }

        const linkedAccount = await this.db.findAccountByDiscordId(discordUser.id);
        if (linkedAccount) {
            const syncedAccount = await this.db.linkDiscordToAccount(linkedAccount.user_id, discordUser);
            return {
                ok: true,
                reason: 'ok',
                mode: 'login',
                account: syncedAccount,
                discordUser,
                message: 'Discord login successful.'
            };
        }

        const existingEmailAccount = await this.db.getAccount(discordUser.email ?? '');
        if (existingEmailAccount) {
            const existingDiscordId = normalizeDiscordId(existingEmailAccount.discordId);
            if (existingDiscordId && existingDiscordId !== discordUser.id) {
                return toDiscordOAuthFailure(
                    'duplicate-discord-linked-account',
                    'login',
                    discordUser,
                    'That Discord email is already tied to a different linked game account.'
                );
            }

            try {
                const linkedExistingAccount = await this.db.linkDiscordToAccount(existingEmailAccount.user_id, discordUser);
                return {
                    ok: true,
                    reason: 'ok',
                    mode: 'login',
                    account: linkedExistingAccount,
                    discordUser,
                    message: 'Discord linked and login successful.'
                };
            } catch (err) {
                return this.accountWriteFailure('login', discordUser, err);
            }
        }

        const generatedEmail = deriveDiscordAccountEmail(discordUser.email ?? '', discordUser.id);
        if (!generatedEmail) {
            return toDiscordOAuthFailure(
                'missing-discord-email',
                'login',
                discordUser,
                'Discord did not provide a usable verified email address.'
            );
        }

        try {
            const account = await this.db.createDiscordAccount(generatedEmail, discordUser);
            return {
                ok: true,
                reason: 'created',
                mode: 'login',
                account,
                discordUser,
                message: 'Discord account created and login successful.'
            };
        } catch (err) {
            return this.accountWriteFailure('login', discordUser, err);
        }
    }

    private accountWriteFailure(
        mode: 'login' | 'link',
        discordUser: DiscordAccountProfile,
        err: unknown
    ): DiscordOAuthCompleteResult {
        const message = (err as Error).message || 'Discord account synchronization failed.';
        const duplicate = /already linked|already used|different linked/i.test(message);
        return toDiscordOAuthFailure(
            duplicate ? 'duplicate-discord-linked-account' : 'account-sync-failed',
            mode,
            discordUser,
            message
        );
    }

    private async createAuthorizeUrlForState(
        state: Pick<DiscordOAuthStatePayload, 'mode' | 'email' | 'userId'>
    ): Promise<DiscordLinkStartResult> {
        if (!this.isConfigured()) {
            return {
                ok: false,
                reason: 'not-configured',
                message: 'Discord OAuth requires DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI.'
            };
        }

        if (state.mode === 'link' && (!state.email || !state.userId)) {
            return {
                ok: false,
                reason: 'missing-account',
                message: 'Discord linking requires an authenticated game account.'
            };
        }

        const signedState = this.signState({
            mode: state.mode,
            email: normalizeEmail(state.email),
            userId: Math.max(0, Math.round(Number(state.userId ?? 0))) || undefined,
            expiresAt: Date.now() + 10 * 60 * 1000,
            nonce: crypto.randomBytes(16).toString('hex')
        });
        const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
        authorizeUrl.searchParams.set('client_id', this.appId);
        authorizeUrl.searchParams.set('redirect_uri', this.redirectUri);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('scope', 'identify email');
        authorizeUrl.searchParams.set('state', signedState);
        if (process.env.DISCORD_OAUTH_PROMPT_CONSENT === '1') {
            authorizeUrl.searchParams.set('prompt', 'consent');
        }

        return {
            ok: true,
            reason: 'ok',
            authorizeUrl: authorizeUrl.toString()
        };
    }

    private async completeLinkMode(
        payload: DiscordOAuthStatePayload,
        discordUser: DiscordAccountProfile
    ): Promise<DiscordOAuthCompleteResult> {
        const emailFailure = this.requireVerifiedDiscordEmail('link', discordUser);
        if (emailFailure) {
            return emailFailure;
        }

        const userId = Math.max(0, Math.round(Number(payload.userId ?? 0)));
        if (!userId) {
            return {
                ok: false,
                reason: 'missing-account',
                mode: 'link',
                discordUser,
                message: 'Discord linking requires an authenticated game account.'
            };
        }

        try {
            const account = await this.db.linkDiscordToAccount(userId, discordUser);
            return {
                ok: true,
                reason: 'ok',
                mode: 'link',
                account,
                discordUser,
                message: 'Discord linked successfully.'
            };
        } catch (err) {
            return this.accountWriteFailure('link', discordUser, err);
        }
    }

    private signState(payload: DiscordOAuthStatePayload): string {
        const body = base64UrlEncode(JSON.stringify(payload));
        const signature = crypto
            .createHmac('sha256', this.stateSecret)
            .update(body)
            .digest('base64url');
        return `${body}.${signature}`;
    }

    private verifyState(state: string): DiscordOAuthStatePayload | null {
        const [body, signature] = String(state ?? '').split('.');
        if (!body || !signature) {
            return null;
        }

        const expected = crypto
            .createHmac('sha256', this.stateSecret)
            .update(body)
            .digest('base64url');
        const expectedBuffer = Buffer.from(expected);
        const actualBuffer = Buffer.from(signature);
        if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
            return null;
        }

        try {
            const parsed = JSON.parse(base64UrlDecode(body)) as DiscordOAuthStatePayload;
            const mode = parsed.mode === 'link' ? 'link' : parsed.mode === 'login' ? 'login' : null;
            if (!mode || Date.now() > Number(parsed.expiresAt ?? 0)) {
                return null;
            }

            return {
                mode,
                email: normalizeEmail(parsed.email),
                userId: Math.max(0, Math.round(Number(parsed.userId ?? 0))) || undefined,
                expiresAt: Number(parsed.expiresAt),
                nonce: String(parsed.nonce ?? '')
            };
        } catch {
            return null;
        }
    }

    private async exchangeCode(code: string): Promise<DiscordTokenResponse> {
        const body = new URLSearchParams({
            client_id: this.appId,
            client_secret: this.clientSecret,
            grant_type: 'authorization_code',
            code,
            redirect_uri: this.redirectUri
        });
        const response = await fetch('https://discord.com/api/v10/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body
        });
        const parsed = await response.json().catch(() => ({})) as DiscordTokenResponse;
        if (!response.ok) {
            return {
                error: parsed.error || `http-${response.status}`,
                error_description: parsed.error_description || response.statusText
            };
        }
        return parsed;
    }

    private async fetchCurrentUser(accessToken: string): Promise<DiscordApiUser | null> {
        const response = await fetch('https://discord.com/api/v10/users/@me', {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });
        if (!response.ok) {
            return null;
        }
        return await response.json().catch(() => null) as DiscordApiUser | null;
    }
}
