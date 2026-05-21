import * as crypto from 'crypto';

import { Config } from '../core/config';
import { JsonAdapter } from '../database/JsonAdapter';
import { DiscordAccountLinkRecord, DiscordAccountLinkStore, DiscordUserProfile } from './DiscordAccountLinkStore';

interface LinkStatePayload {
    email: string;
    userId: number;
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

const DEFAULT_PUBLIC_REDIRECT_URI =
    'https://discord-github-assistant-bot.vercel.app/api/discord/link/callback';

export interface DiscordLinkStartResult {
    ok: boolean;
    reason: string;
    authorizeUrl?: string;
    link?: DiscordAccountLinkRecord;
    message?: string;
}

export interface DiscordLinkCompleteResult {
    ok: boolean;
    reason: string;
    link?: DiscordAccountLinkRecord;
    message?: string;
}

function base64UrlEncode(value: string | Buffer): string {
    return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value: string): string {
    return Buffer.from(value, 'base64url').toString('utf8');
}

function normalizeEmail(email: string | null | undefined): string {
    return String(email ?? '').trim().toLowerCase();
}

export class DiscordAccountLinkService {
    private readonly db = new JsonAdapter();
    private readonly store = new DiscordAccountLinkStore();
    private readonly appId: string;
    private readonly clientSecret: string;
    private readonly redirectUri: string;
    private readonly stateSecret: string;

    constructor() {
        this.appId = String(process.env.DISCORD_APPLICATION_ID ?? process.env.DISCORD_SOCIAL_APP_ID ?? '').trim();
        this.clientSecret = String(process.env.DISCORD_CLIENT_SECRET ?? '').trim();
        this.redirectUri = this.resolveRedirectUri();
        this.stateSecret = String(process.env.DISCORD_ACCOUNT_LINK_STATE_SECRET ?? Config.SECRET).trim();
    }

    public isConfigured(): boolean {
        return Boolean(this.appId && this.clientSecret && this.redirectUri && this.stateSecret);
    }

    public async createAuthorizeUrl(email: string): Promise<DiscordLinkStartResult> {
        if (!this.isConfigured()) {
            return {
                ok: false,
                reason: 'not-configured',
                message: 'Discord account linking requires DISCORD_APPLICATION_ID and DISCORD_CLIENT_SECRET.'
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

        const userId = await this.db.getAccountId(normalizedEmail);
        if (!userId) {
            return {
                ok: false,
                reason: 'account-not-found',
                message: 'No game account exists for that email.'
            };
        }

        const existingLink = await this.store.findByEmail(normalizedEmail);
        if (existingLink && existingLink.userId === userId) {
            return {
                ok: true,
                reason: 'already-linked',
                link: existingLink,
                message: 'Discord account is already linked.'
            };
        }

        const state = this.signState({
            email: normalizedEmail,
            userId,
            expiresAt: Date.now() + 10 * 60 * 1000,
            nonce: crypto.randomBytes(12).toString('hex')
        });
        const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
        authorizeUrl.searchParams.set('client_id', this.appId);
        authorizeUrl.searchParams.set('redirect_uri', this.redirectUri);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('scope', 'identify');
        authorizeUrl.searchParams.set('state', state);

        return {
            ok: true,
            reason: 'ok',
            authorizeUrl: authorizeUrl.toString()
        };
    }

    public async completeLink(code: string, state: string): Promise<DiscordLinkCompleteResult> {
        if (!this.isConfigured()) {
            return {
                ok: false,
                reason: 'not-configured',
                message: 'Discord account linking is not configured.'
            };
        }

        const payload = this.verifyState(state);
        if (!payload) {
            return {
                ok: false,
                reason: 'invalid-state',
                message: 'Discord account link state is invalid or expired.'
            };
        }

        const trimmedCode = String(code ?? '').trim();
        if (!trimmedCode) {
            return {
                ok: false,
                reason: 'missing-code',
                message: 'Discord did not return an authorization code.'
            };
        }

        const token = await this.exchangeCode(trimmedCode);
        if (!token.access_token) {
            return {
                ok: false,
                reason: 'token-exchange-failed',
                message: token.error_description || token.error || 'Discord token exchange failed.'
            };
        }

        const discordUser = await this.fetchCurrentUser(token.access_token);
        if (!discordUser?.id) {
            return {
                ok: false,
                reason: 'user-fetch-failed',
                message: 'Could not fetch Discord user profile.'
            };
        }

        const link = await this.store.linkAccount(payload.email, payload.userId, discordUser);
        return {
            ok: true,
            reason: 'ok',
            link
        };
    }

    private resolveRedirectUri(): string {
        const configured = String(process.env.DISCORD_ACCOUNT_LINK_REDIRECT_URI ?? '').trim();
        if (configured) {
            return configured;
        }

        const baseUrl = String(process.env.DISCORD_ACCOUNT_LINK_BASE_URL ?? '').trim();
        if (baseUrl) {
            return `${baseUrl.replace(/\/+$/, '')}/api/discord/link/callback`;
        }

        return DEFAULT_PUBLIC_REDIRECT_URI;
    }

    private signState(payload: LinkStatePayload): string {
        const body = base64UrlEncode(JSON.stringify(payload));
        const signature = crypto
            .createHmac('sha256', this.stateSecret)
            .update(body)
            .digest('base64url');
        return `${body}.${signature}`;
    }

    private verifyState(state: string): LinkStatePayload | null {
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
            const parsed = JSON.parse(base64UrlDecode(body)) as LinkStatePayload;
            if (!parsed.email || !parsed.userId || Date.now() > Number(parsed.expiresAt ?? 0)) {
                return null;
            }
            return {
                email: normalizeEmail(parsed.email),
                userId: Math.max(0, Math.round(Number(parsed.userId))),
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

    private async fetchCurrentUser(accessToken: string): Promise<DiscordUserProfile | null> {
        const response = await fetch('https://discord.com/api/v10/users/@me', {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });
        if (!response.ok) {
            return null;
        }
        return await response.json().catch(() => null) as DiscordUserProfile | null;
    }
}
