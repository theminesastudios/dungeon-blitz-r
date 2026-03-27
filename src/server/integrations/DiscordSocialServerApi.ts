export class DiscordSocialServerApi {
    private readonly token: string;
    private readonly enabled: boolean;

    constructor() {
        this.token = String(process.env.DISCORD_BOT_TOKEN ?? '').trim();
        this.enabled = this.token.length > 0;
    }

    public isEnabled(): boolean {
        return this.enabled;
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
