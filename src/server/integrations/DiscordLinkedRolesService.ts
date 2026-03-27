import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Request } from 'express';

import { Config } from '../core/config';
import { JsonAdapter } from '../database/JsonAdapter';
import type { Character } from '../database/Database';

interface LinkedRoleStatePayload {
    accountId: number;
    characterName: string;
    issuedAtMs: number;
}

interface StoredOAuthToken {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scope: string;
}

interface StoredLinkedAccount {
    accountId: number;
    characterName: string;
    linkedAt: string;
    updatedAt: string;
}

interface LinkedRoleStore {
    oauthByDiscordUserId: Record<string, StoredOAuthToken>;
    linksByDiscordUserId: Record<string, StoredLinkedAccount>;
    discordUserIdByAccountId: Record<string, string>;
}

export interface DungeonBlitzLinkedRoleProfile {
    accountId: number;
    accountEmail: string | null;
    characterName: string;
    className: string;
    level: number;
    sponsor: boolean;
}

const db = new JsonAdapter();

function normalizeName(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

function toInt(value: unknown, fallback: number = 0): number {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

async function readAccountsFile(): Promise<Array<{ email: string; user_id: number }>> {
    const accountsPath = path.resolve(Config.DATA_DIR, 'Accounts.json');
    try {
        const raw = await fs.readFile(accountsPath, 'utf8');
        if (!raw.trim()) {
            return [];
        }

        return JSON.parse(raw) as Array<{ email: string; user_id: number }>;
    } catch {
        return [];
    }
}

export class DiscordLinkedRolesService {
    private static readonly STATE_TTL_MS = 15 * 60 * 1000;

    private getStorePath(): string {
        return path.resolve(Config.DATA_DIR, '.discord-linked-roles.json');
    }

    private getStateSecret(): string {
        return String(process.env.DISCORD_LINKED_ROLES_STATE_SECRET ?? '').trim() || Config.SECRET;
    }

    private getApplicationId(): string {
        return String(process.env.DISCORD_APPLICATION_ID ?? process.env.DISCORD_SOCIAL_APP_ID ?? '').trim();
    }

    private getClientSecret(): string {
        return String(process.env.DISCORD_CLIENT_SECRET ?? '').trim();
    }

    private isSponsor(accountId: number, accountEmail: string | null): boolean {
        const configuredIds = String(process.env.DISCORD_LINKED_ROLES_SPONSOR_ACCOUNT_IDS ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
        if (configuredIds.includes(String(accountId))) {
            return true;
        }

        const normalizedEmail = normalizeName(accountEmail);
        if (!normalizedEmail) {
            return false;
        }

        const configuredEmails = String(process.env.DISCORD_LINKED_ROLES_SPONSOR_EMAILS ?? '')
            .split(',')
            .map((entry) => normalizeName(entry))
            .filter(Boolean);
        return configuredEmails.includes(normalizedEmail);
    }

    private async readStore(): Promise<LinkedRoleStore> {
        const storePath = this.getStorePath();
        try {
            const raw = await fs.readFile(storePath, 'utf8');
            if (!raw.trim()) {
                throw new Error('empty');
            }

            const parsed = JSON.parse(raw) as Partial<LinkedRoleStore>;
            return {
                oauthByDiscordUserId: parsed.oauthByDiscordUserId ?? {},
                linksByDiscordUserId: parsed.linksByDiscordUserId ?? {},
                discordUserIdByAccountId: parsed.discordUserIdByAccountId ?? {}
            };
        } catch {
            return {
                oauthByDiscordUserId: {},
                linksByDiscordUserId: {},
                discordUserIdByAccountId: {}
            };
        }
    }

    private async writeStore(store: LinkedRoleStore): Promise<void> {
        await fs.writeFile(this.getStorePath(), JSON.stringify(store, null, 2), 'utf8');
    }

    private signPayload(payload: string): string {
        return crypto
            .createHmac('sha256', this.getStateSecret())
            .update(payload)
            .digest('base64url');
    }

    public createSignedState(accountId: number, characterName: string): string {
        const payloadJson = JSON.stringify({
            accountId,
            characterName,
            issuedAtMs: Date.now()
        } satisfies LinkedRoleStatePayload);
        const payloadEncoded = Buffer.from(payloadJson, 'utf8').toString('base64url');
        const signature = this.signPayload(payloadJson);
        return `${payloadEncoded}.${signature}`;
    }

    public verifyState(rawState: string): LinkedRoleStatePayload {
        const state = String(rawState ?? '').trim();
        const separator = state.indexOf('.');
        if (separator <= 0 || separator >= state.length - 1) {
            throw new Error('Invalid linked role state.');
        }

        const payloadEncoded = state.slice(0, separator);
        const signature = state.slice(separator + 1);
        const payloadJson = Buffer.from(payloadEncoded, 'base64url').toString('utf8');
        const expectedSignature = this.signPayload(payloadJson);
        if (signature !== expectedSignature) {
            throw new Error('Linked role state signature mismatch.');
        }

        const payload = JSON.parse(payloadJson) as Partial<LinkedRoleStatePayload>;
        const accountId = toInt(payload.accountId, 0);
        const characterName = String(payload.characterName ?? '').trim();
        const issuedAtMs = toInt(payload.issuedAtMs, 0);
        if (!accountId || !characterName || !issuedAtMs) {
            throw new Error('Linked role state is incomplete.');
        }

        if (Date.now() - issuedAtMs > DiscordLinkedRolesService.STATE_TTL_MS) {
            throw new Error('Linked role state expired. Start the flow again from Dungeon Blitz.');
        }

        return { accountId, characterName, issuedAtMs };
    }

    public buildRedirectUri(req: Request): string {
        const configured = String(process.env.DISCORD_LINKED_ROLES_REDIRECT_URI ?? '').trim();
        if (configured) {
            return configured;
        }

        const host = String(req.get('host') ?? '').trim();
        if (!host) {
            throw new Error('Could not resolve request host for Linked Roles redirect URI.');
        }

        return `http://${host}/api/discord-linked-roles/callback`;
    }

    public buildAuthorizeUrl(req: Request, accountId: number, characterName: string): string {
        const applicationId = this.getApplicationId();
        if (!applicationId) {
            throw new Error('DISCORD_APPLICATION_ID is missing.');
        }

        const redirectUri = this.buildRedirectUri(req);
        const params = new URLSearchParams({
            client_id: applicationId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: 'identify role_connections.write',
            prompt: 'consent',
            state: this.createSignedState(accountId, characterName)
        });

        return `https://discord.com/oauth2/authorize?${params.toString()}`;
    }

    private async exchangeCode(code: string, redirectUri: string): Promise<{
        access_token: string;
        refresh_token: string;
        expires_in: number;
        scope: string;
    }> {
        const applicationId = this.getApplicationId();
        const clientSecret = this.getClientSecret();
        if (!applicationId || !clientSecret) {
            throw new Error('DISCORD_APPLICATION_ID or DISCORD_CLIENT_SECRET is missing.');
        }

        const response = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: applicationId,
                client_secret: clientSecret,
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri
            })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload) {
            throw new Error(`Discord token exchange failed: ${response.status} ${response.statusText}`);
        }

        return payload as {
            access_token: string;
            refresh_token: string;
            expires_in: number;
            scope: string;
        };
    }

    private async refreshToken(refreshToken: string): Promise<StoredOAuthToken> {
        const applicationId = this.getApplicationId();
        const clientSecret = this.getClientSecret();
        if (!applicationId || !clientSecret) {
            throw new Error('DISCORD_APPLICATION_ID or DISCORD_CLIENT_SECRET is missing.');
        }

        const response = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: applicationId,
                client_secret: clientSecret,
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload) {
            throw new Error(`Discord token refresh failed: ${response.status} ${response.statusText}`);
        }

        return {
            accessToken: String(payload.access_token ?? '').trim(),
            refreshToken: String(payload.refresh_token ?? refreshToken).trim(),
            expiresAt: Date.now() + Math.max(60, toInt(payload.expires_in, 3600)) * 1000,
            scope: String(payload.scope ?? '').trim()
        };
    }

    private async fetchDiscordUser(accessToken: string): Promise<{ id: string; username: string }> {
        const response = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload || !payload.id) {
            throw new Error(`Failed to fetch Discord user: ${response.status} ${response.statusText}`);
        }

        return {
            id: String(payload.id),
            username: String(payload.username ?? 'Discord')
        };
    }

    private pickCharacter(characters: Character[], preferredCharacterName: string): Character | null {
        const preferred = normalizeName(preferredCharacterName);
        if (preferred) {
            const match = characters.find((entry) => normalizeName(entry.name) === preferred);
            if (match) {
                return match;
            }
        }

        if (characters.length === 0) {
            return null;
        }

        return [...characters].sort((left, right) => {
            const levelDelta = toInt(right.level, 1) - toInt(left.level, 1);
            if (levelDelta !== 0) {
                return levelDelta;
            }

            return String(left.name ?? '').localeCompare(String(right.name ?? ''));
        })[0] ?? null;
    }

    public async getProfile(accountId: number, preferredCharacterName: string): Promise<DungeonBlitzLinkedRoleProfile> {
        const characters = await db.loadCharacters(accountId);
        const selected = this.pickCharacter(characters, preferredCharacterName);
        if (!selected) {
            throw new Error(`Dungeon Blitz account ${accountId} has no character data to expose.`);
        }

        const accounts = await readAccountsFile();
        const accountEmail =
            accounts.find((entry) => Number(entry.user_id) === accountId)?.email?.trim() || null;
        const className = String(selected.class ?? 'Unknown').trim() || 'Unknown';

        return {
            accountId,
            accountEmail,
            characterName: String(selected.name ?? 'Unknown').trim() || 'Unknown',
            className,
            level: Math.max(1, toInt(selected.level, 1)),
            sponsor: this.isSponsor(accountId, accountEmail)
        };
    }

    private async getFreshAccessToken(discordUserId: string, store: LinkedRoleStore): Promise<string> {
        const token = store.oauthByDiscordUserId[discordUserId];
        if (!token?.accessToken) {
            throw new Error('Discord OAuth token was not found for this linked account.');
        }

        if (token.expiresAt > Date.now() + 60_000) {
            return token.accessToken;
        }

        if (!token.refreshToken) {
            return token.accessToken;
        }

        const refreshed = await this.refreshToken(token.refreshToken);
        store.oauthByDiscordUserId[discordUserId] = refreshed;
        await this.writeStore(store);
        return refreshed.accessToken;
    }

    public async completeOAuth(req: Request, code: string, rawState: string): Promise<{
        discordUserId: string;
        discordUsername: string;
        profile: DungeonBlitzLinkedRoleProfile;
    }> {
        const state = this.verifyState(rawState);
        const redirectUri = this.buildRedirectUri(req);
        const tokens = await this.exchangeCode(code, redirectUri);
        const discordUser = await this.fetchDiscordUser(tokens.access_token);
        const store = await this.readStore();
        const linkedAt =
            store.linksByDiscordUserId[discordUser.id]?.linkedAt || new Date().toISOString();

        store.oauthByDiscordUserId[discordUser.id] = {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: Date.now() + Math.max(60, toInt(tokens.expires_in, 3600)) * 1000,
            scope: String(tokens.scope ?? '').trim()
        };
        store.linksByDiscordUserId[discordUser.id] = {
            accountId: state.accountId,
            characterName: state.characterName,
            linkedAt,
            updatedAt: new Date().toISOString()
        };
        store.discordUserIdByAccountId[String(state.accountId)] = discordUser.id;
        await this.writeStore(store);

        const profile = await this.pushMetadataForDiscordUser(discordUser.id);
        return {
            discordUserId: discordUser.id,
            discordUsername: discordUser.username,
            profile
        };
    }

    public async pushMetadataForAccount(accountId: number, characterName: string): Promise<DungeonBlitzLinkedRoleProfile> {
        const store = await this.readStore();
        const discordUserId = store.discordUserIdByAccountId[String(accountId)];
        if (!discordUserId) {
            throw new Error('No Discord account is linked to this Dungeon Blitz account yet.');
        }

        const existingLink = store.linksByDiscordUserId[discordUserId];
        store.linksByDiscordUserId[discordUserId] = {
            accountId,
            characterName,
            linkedAt: existingLink?.linkedAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        await this.writeStore(store);
        return this.pushMetadataForDiscordUser(discordUserId);
    }

    public async pushMetadataForDiscordUser(discordUserId: string): Promise<DungeonBlitzLinkedRoleProfile> {
        const store = await this.readStore();
        const link = store.linksByDiscordUserId[discordUserId];
        if (!link) {
            throw new Error('Linked Roles are not connected to a Dungeon Blitz account yet.');
        }

        const accessToken = await this.getFreshAccessToken(discordUserId, store);
        const profile = await this.getProfile(link.accountId, link.characterName);
        const applicationId = this.getApplicationId();
        if (!applicationId) {
            throw new Error('DISCORD_APPLICATION_ID is missing.');
        }

        const response = await fetch(
            `https://discord.com/api/v10/users/@me/applications/${applicationId}/role-connection`,
            {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    platform_name: 'Dungeon Blitz',
                    platform_username: profile.characterName,
                    metadata: {
                        player_level: profile.level,
                        mage: normalizeName(profile.className) === 'mage',
                        rogue: normalizeName(profile.className) === 'rogue',
                        paladin: normalizeName(profile.className) === 'paladin',
                        sponsor: profile.sponsor
                    }
                })
            }
        );

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(
                `Failed to update Discord linked-role metadata: ${response.status} ${response.statusText}${errorText ? ` ${errorText}` : ''}`
            );
        }

        store.linksByDiscordUserId[discordUserId] = {
            ...link,
            characterName: profile.characterName,
            updatedAt: new Date().toISOString()
        };
        store.discordUserIdByAccountId[String(profile.accountId)] = discordUserId;
        await this.writeStore(store);
        return profile;
    }
}

export const discordLinkedRolesService = new DiscordLinkedRolesService();
