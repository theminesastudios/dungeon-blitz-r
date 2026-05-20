import * as fs from 'fs/promises';
import * as path from 'path';

import { Config } from '../core/config';

export interface DiscordAccountLinkRecord {
    email: string;
    userId: number;
    discordUserId: string;
    discordUsername: string;
    discordGlobalName: string;
    linkedAt: string;
}

interface DiscordAccountLinksFile {
    links: DiscordAccountLinkRecord[];
}

export interface DiscordUserProfile {
    id: string;
    username?: string;
    global_name?: string | null;
}

function normalizeEmail(email: string | null | undefined): string {
    return String(email ?? '').trim().toLowerCase();
}

function normalizeDiscordUserId(value: string | null | undefined): string {
    return String(value ?? '').trim();
}

export class DiscordAccountLinkStore {
    private readonly linksPath: string;

    constructor(linksPath: string = path.resolve(Config.DATA_DIR, 'data', 'discord_account_links.json')) {
        this.linksPath = linksPath;
    }

    public async findByEmail(email: string | null | undefined): Promise<DiscordAccountLinkRecord | null> {
        const normalizedEmail = normalizeEmail(email);
        if (!normalizedEmail) {
            return null;
        }

        const file = await this.readLinksFile();
        return file.links.find((record) => normalizeEmail(record.email) === normalizedEmail) ?? null;
    }

    public async findByDiscordUserId(discordUserId: string | null | undefined): Promise<DiscordAccountLinkRecord | null> {
        const normalizedUserId = normalizeDiscordUserId(discordUserId);
        if (!normalizedUserId) {
            return null;
        }

        const file = await this.readLinksFile();
        return file.links.find((record) => normalizeDiscordUserId(record.discordUserId) === normalizedUserId) ?? null;
    }

    public async linkAccount(
        email: string,
        userId: number,
        discordUser: DiscordUserProfile
    ): Promise<DiscordAccountLinkRecord> {
        const normalizedEmail = normalizeEmail(email);
        const discordUserId = normalizeDiscordUserId(discordUser.id);
        if (!normalizedEmail || userId <= 0 || !discordUserId) {
            throw new Error('Cannot link Discord account without email, user id, and Discord user id.');
        }

        const file = await this.readLinksFile();
        const nextRecord: DiscordAccountLinkRecord = {
            email: normalizedEmail,
            userId,
            discordUserId,
            discordUsername: String(discordUser.username ?? '').trim(),
            discordGlobalName: String(discordUser.global_name ?? '').trim(),
            linkedAt: new Date().toISOString()
        };

        file.links = file.links.filter((record) =>
            normalizeEmail(record.email) !== normalizedEmail &&
            normalizeDiscordUserId(record.discordUserId) !== discordUserId
        );
        file.links.push(nextRecord);
        file.links.sort((left, right) => left.email.localeCompare(right.email));

        await this.writeLinksFile(file);
        return nextRecord;
    }

    private async readLinksFile(): Promise<DiscordAccountLinksFile> {
        try {
            const raw = await fs.readFile(this.linksPath, 'utf8');
            const parsed = JSON.parse(raw) as DiscordAccountLinksFile;
            return {
                links: Array.isArray(parsed?.links) ? parsed.links : []
            };
        } catch (error: any) {
            if (error?.code === 'ENOENT') {
                return { links: [] };
            }
            throw error;
        }
    }

    private async writeLinksFile(file: DiscordAccountLinksFile): Promise<void> {
        await fs.mkdir(path.dirname(this.linksPath), { recursive: true });
        const tempPath = `${this.linksPath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(file, null, 2));
        await fs.rename(tempPath, this.linksPath);
    }
}
