export class DiscordSocialServerApi {
    private readonly token: string;
    private readonly enabled: boolean;
    private readonly configuredGuildId: string;
    private readonly guildIdByChannelId = new Map<string, string>();
    private readonly displayNameByMemberKey = new Map<string, string>();

    constructor() {
        this.token = String(process.env.DISCORD_BOT_TOKEN ?? '').trim();
        this.enabled = this.token.length > 0;
        this.configuredGuildId = String(process.env.DISCORD_SOCIAL_GUILD_ID ?? process.env.DISCORD_GUILD_ID ?? '').trim();
    }

    public isEnabled(): boolean {
        return this.enabled;
    }

    public async fetchUserDisplayName(discordUserId: string): Promise<string | null> {
        if (!this.enabled) {
            return null;
        }

        const targetUserId = String(discordUserId ?? '').trim();
        if (!targetUserId) {
            return null;
        }

        try {
            const response = await fetch(`https://discord.com/api/v10/users/${targetUserId}`, {
                headers: {
                    Authorization: `Bot ${this.token}`
                }
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                console.error(
                    `[DiscordSocialServerApi] Failed to fetch Discord user ${targetUserId}: ${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ''}`
                );
                return null;
            }

            const parsed = await response.json().catch(() => null) as { global_name?: string | null; username?: string; id?: string } | null;
            const globalName = String(parsed?.global_name ?? '').trim();
            const username = String(parsed?.username ?? '').trim();
            return globalName || username || String(parsed?.id ?? '').trim() || null;
        } catch (error) {
            console.error('[DiscordSocialServerApi] fetchUserDisplayName request failed:', error);
            return null;
        }
    }

    public async fetchChannelMemberDisplayName(channelId: string, discordUserId: string): Promise<string | null> {
        if (!this.enabled) {
            return null;
        }

        const targetUserId = DiscordSocialServerApi.cleanSnowflake(discordUserId);
        if (!targetUserId) {
            return null;
        }

        const guildId = this.configuredGuildId || await this.fetchGuildIdForChannel(channelId);
        if (!guildId) {
            return null;
        }

        return this.fetchGuildMemberDisplayName(guildId, targetUserId);
    }

    public async fetchGuildMemberDisplayName(guildId: string, discordUserId: string): Promise<string | null> {
        if (!this.enabled) {
            return null;
        }

        const targetGuildId = DiscordSocialServerApi.cleanSnowflake(guildId);
        const targetUserId = DiscordSocialServerApi.cleanSnowflake(discordUserId);
        if (!targetGuildId || !targetUserId) {
            return null;
        }

        const cacheKey = `${targetGuildId}:${targetUserId}`;
        const cached = this.displayNameByMemberKey.get(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            const response = await fetch(`https://discord.com/api/v10/guilds/${targetGuildId}/members/${targetUserId}`, {
                headers: {
                    Authorization: `Bot ${this.token}`
                }
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                console.error(
                    `[DiscordSocialServerApi] Failed to fetch Discord member ${targetUserId} in guild ${targetGuildId}: ${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ''}`
                );
                return null;
            }

            const parsed = await response.json().catch(() => null) as {
                nick?: string | null;
                user?: {
                    global_name?: string | null;
                    username?: string;
                    id?: string;
                } | null;
            } | null;
            const displayName = DiscordSocialServerApi.pickDisplayName(
                parsed?.nick,
                parsed?.user?.global_name,
                parsed?.user?.username,
                parsed?.user?.id
            );
            if (displayName) {
                this.displayNameByMemberKey.set(cacheKey, displayName);
            }
            return displayName;
        } catch (error) {
            console.error('[DiscordSocialServerApi] fetchGuildMemberDisplayName request failed:', error);
            return null;
        }
    }

    public async fetchMessageAuthorDisplayName(channelId: string, messageId: string, fallbackUserId?: string): Promise<string | null> {
        if (!this.enabled) {
            return null;
        }

        const targetChannelId = DiscordSocialServerApi.cleanSnowflake(channelId);
        const targetMessageId = DiscordSocialServerApi.cleanSnowflake(messageId);
        if (!targetChannelId || !targetMessageId) {
            return null;
        }

        try {
            const response = await fetch(`https://discord.com/api/v10/channels/${targetChannelId}/messages/${targetMessageId}`, {
                headers: {
                    Authorization: `Bot ${this.token}`
                }
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                console.error(
                    `[DiscordSocialServerApi] Failed to fetch Discord channel message ${targetMessageId}: ${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ''}`
                );
                return null;
            }

            const parsed = await response.json().catch(() => null) as {
                author?: {
                    global_name?: string | null;
                    username?: string;
                    id?: string;
                } | null;
                member?: {
                    nick?: string | null;
                } | null;
            } | null;
            const displayName = DiscordSocialServerApi.pickDisplayName(
                parsed?.member?.nick,
                parsed?.author?.global_name,
                parsed?.author?.username,
                parsed?.author?.id,
                fallbackUserId
            );
            return displayName;
        } catch (error) {
            console.error('[DiscordSocialServerApi] fetchMessageAuthorDisplayName request failed:', error);
            return null;
        }
    }

    public async fetchRecentChannelMessageAuthorDisplayName(
        channelId: string,
        content: string,
        sentTimestampMs?: string | number | null
    ): Promise<string | null> {
        if (!this.enabled) {
            return null;
        }

        const targetChannelId = DiscordSocialServerApi.cleanSnowflake(channelId);
        const targetContent = DiscordSocialServerApi.normalizeMessageContent(content);
        if (!targetChannelId || !targetContent) {
            return null;
        }
        const targetTimestamp = DiscordSocialServerApi.parseTimestampMs(sentTimestampMs);

        try {
            const response = await fetch(`https://discord.com/api/v10/channels/${targetChannelId}/messages?limit=25`, {
                headers: {
                    Authorization: `Bot ${this.token}`
                }
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                console.error(
                    `[DiscordSocialServerApi] Failed to fetch recent Discord channel messages for ${targetChannelId}: ${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ''}`
                );
                return null;
            }

            const parsed = await response.json().catch(() => null) as Array<{
                content?: string;
                author?: {
                    bot?: boolean;
                    global_name?: string | null;
                    username?: string;
                    id?: string;
                } | null;
                member?: {
                    nick?: string | null;
                } | null;
                timestamp?: string;
            }> | null;
            if (!Array.isArray(parsed)) {
                return null;
            }

            let closest: { delta: number; displayName: string } | null = null;
            for (const message of parsed) {
                if (message?.author?.bot) {
                    continue;
                }

                if (DiscordSocialServerApi.normalizeMessageContent(message?.content) !== targetContent) {
                    continue;
                }

                const displayName = DiscordSocialServerApi.pickDisplayName(
                    message?.member?.nick,
                    message?.author?.global_name,
                    message?.author?.username,
                    message?.author?.id
                );
                if (!displayName) {
                    continue;
                }

                if (targetTimestamp == null) {
                    return displayName;
                }

                const messageTimestamp = DiscordSocialServerApi.parseTimestampMs(message?.timestamp);
                if (messageTimestamp == null) {
                    continue;
                }

                const delta = Math.abs(messageTimestamp - targetTimestamp);
                if (delta > 15000) {
                    continue;
                }

                if (!closest || delta < closest.delta) {
                    closest = { delta, displayName };
                }
            }

            return closest?.displayName ?? null;
        } catch (error) {
            console.error('[DiscordSocialServerApi] fetchRecentChannelMessageAuthorDisplayName request failed:', error);
            return null;
        }
    }

    private async fetchGuildIdForChannel(channelId: string): Promise<string | null> {
        const targetChannelId = DiscordSocialServerApi.cleanSnowflake(channelId);
        if (!targetChannelId) {
            return null;
        }

        const cached = this.guildIdByChannelId.get(targetChannelId);
        if (cached) {
            return cached;
        }

        try {
            const response = await fetch(`https://discord.com/api/v10/channels/${targetChannelId}`, {
                headers: {
                    Authorization: `Bot ${this.token}`
                }
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                console.error(
                    `[DiscordSocialServerApi] Failed to fetch Discord channel ${targetChannelId}: ${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ''}`
                );
                return null;
            }

            const parsed = await response.json().catch(() => null) as { guild_id?: string } | null;
            const guildId = DiscordSocialServerApi.cleanSnowflake(parsed?.guild_id);
            if (guildId) {
                this.guildIdByChannelId.set(targetChannelId, guildId);
            }
            return guildId || null;
        } catch (error) {
            console.error('[DiscordSocialServerApi] fetchGuildIdForChannel request failed:', error);
            return null;
        }
    }

    private static cleanSnowflake(value: string | null | undefined): string {
        const cleaned = String(value ?? '').trim();
        return /^[1-9]\d{4,}$/.test(cleaned) ? cleaned : '';
    }

    private static pickDisplayName(...values: Array<string | null | undefined>): string | null {
        for (const value of values) {
            const cleaned = String(value ?? '')
                .replace(/[\r\n]+/g, ' ')
                .replace(/[\u0000-\u001F\u007F-\u009F\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u2000-\u200F\u2028-\u202F\u205F-\u206F\u2800\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            if (cleaned) {
                return cleaned;
            }
        }

        return null;
    }

    private static normalizeMessageContent(value: string | null | undefined): string {
        return String(value ?? '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/[\u0000-\u001F\u007F-\u009F\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u2000-\u200F\u2028-\u202F\u205F-\u206F\u2800\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private static parseTimestampMs(value: string | number | null | undefined): number | null {
        if (typeof value === 'number') {
            return Number.isFinite(value) && value > 0 ? value : null;
        }

        const raw = String(value ?? '').trim();
        if (!raw) {
            return null;
        }

        const numeric = Number(raw);
        if (Number.isFinite(numeric) && numeric > 0) {
            return numeric;
        }

        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? parsed : null;
    }

    public async sendChannelMessage(channelId: string, content: string): Promise<boolean> {
        if (!this.enabled) {
            console.warn('[DiscordSocialServerApi] DISCORD_BOT_TOKEN is missing; cannot send Discord channel message.');
            return false;
        }

        const targetChannelId = String(channelId ?? '').trim();
        const targetContent = String(content ?? '').trim();
        if (!targetChannelId || !targetContent) {
            return false;
        }

        try {
            const response = await fetch(`https://discord.com/api/v10/channels/${targetChannelId}/messages`, {
                method: 'POST',
                headers: {
                    Authorization: `Bot ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    content: targetContent.slice(0, 2000),
                    allowed_mentions: {
                        parse: []
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                console.error(
                    `[DiscordSocialServerApi] Failed to send channel message: ${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ''}`
                );
                return false;
            }

            return true;
        } catch (error) {
            console.error('[DiscordSocialServerApi] sendChannelMessage request failed:', error);
            return false;
        }
    }

    public async grantCanLinkLobby(lobbyId: string, userId: string): Promise<boolean> {
        if (!this.enabled) {
            console.warn('[DiscordSocialServerApi] DISCORD_BOT_TOKEN is missing; cannot grant CanLinkLobby.');
            return false;
        }

        const targetLobbyId = String(lobbyId ?? '').trim();
        const targetUserId = String(userId ?? '').trim();
        if (!targetLobbyId || !targetUserId) {
            return false;
        }

        try {
            const response = await fetch(`https://discord.com/api/v10/lobbies/${targetLobbyId}/members/${targetUserId}`, {
                method: 'PUT',
                headers: {
                    Authorization: `Bot ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    flags: 1
                })
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                console.error(
                    `[DiscordSocialServerApi] Failed to grant CanLinkLobby: ${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ''}`
                );
                return false;
            }

            return true;
        } catch (error) {
            console.error('[DiscordSocialServerApi] grantCanLinkLobby request failed:', error);
            return false;
        }
    }
}
