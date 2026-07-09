import { Collection, MongoClient } from 'mongodb';

import { Config } from '../core/config';
import { DiscordAccountProfile, SponsorAccountMetadata } from '../database/Database';

type SponsorDocument = Record<string, unknown>;

export interface SponsorEligibilityResult {
    eligible: boolean;
    reason: 'ok' | 'not-required' | 'not-configured' | 'not-found' | 'query-failed' | 'invalid-discord-id';
    message: string;
    metadata: SponsorAccountMetadata;
}

function normalizeDiscordId(value: unknown): string {
    return String(value ?? '').trim();
}

function normalizeFieldPath(value: string): string {
    const field = String(value ?? '').trim();
    if (!field || field.startsWith('$') || !/^[A-Za-z0-9_.-]+$/.test(field)) {
        return '';
    }
    return field;
}

function normalizeFieldList(value: string): string[] {
    const fields = String(value ?? '')
        .split(',')
        .map(normalizeFieldPath)
        .filter(Boolean);
    return Array.from(new Set(fields));
}

function getNestedValue(document: SponsorDocument, fieldPath: string): unknown {
    let current: unknown = document;
    for (const part of fieldPath.split('.')) {
        if (!current || typeof current !== 'object') {
            return undefined;
        }
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

function normalizeSponsorRecordId(document: SponsorDocument | null | undefined): string {
    const rawId = document?._id;
    if (!rawId) {
        return '';
    }
    return typeof rawId === 'object' && rawId && 'toString' in rawId
        ? String((rawId as { toString(): string }).toString())
        : String(rawId);
}

export class SponsorEligibilityService {
    private client: MongoClient | null = null;
    private collection: Collection<SponsorDocument> | null = null;
    private readonly discordIdFields = normalizeFieldList(Config.SPONSOR_DISCORD_ID_FIELDS);
    private readonly statusFields = (() => {
        const fields = normalizeFieldList(Config.SPONSOR_STATUS_FIELD);
        return fields.length > 0 ? fields : ['isSponsor'];
    })();

    public isRequiredForAccountCreation(): boolean {
        return Config.SPONSOR_ACCOUNT_CREATION_REQUIRED;
    }

    public isConfigured(): boolean {
        return Boolean(
            Config.SPONSOR_MONGODB_URI &&
            Config.SPONSOR_MONGODB_DB_NAME &&
            Config.SPONSOR_MONGODB_COLLECTION &&
            this.discordIdFields.length > 0 &&
            this.statusFields.length > 0
        );
    }

    public async close(): Promise<void> {
        const client = this.client;
        this.client = null;
        this.collection = null;
        await client?.close();
    }

    public async checkDiscordUser(discordUser: DiscordAccountProfile): Promise<SponsorEligibilityResult> {
        const discordId = normalizeDiscordId(discordUser.id);
        if (!discordId) {
            return this.result(false, 'invalid-discord-id', 'Discord account id is required for sponsor verification.');
        }

        if (!this.isRequiredForAccountCreation()) {
            return {
                eligible: true,
                reason: 'not-required',
                message: 'Sponsor verification is not required on this server.',
                metadata: {
                    sponsorEligible: false,
                    sponsorStatus: 'unknown',
                    sponsorSource: 'not-required',
                    sponsorCheckedAt: new Date().toISOString()
                }
            };
        }

        if (!this.isConfigured()) {
            return this.result(
                false,
                'not-configured',
                'Sponsor verification requires MongoDB sponsor configuration before account creation.'
            );
        }

        try {
            const collection = await this.getCollection();
            const record = await collection.findOne(this.buildSponsorFilter(discordId));
            if (!record) {
                return this.result(
                    false,
                    'not-found',
                    'Discord sponsor verification is required before this game account can be created.'
                );
            }

            const eligible = this.statusFields.some((field) => getNestedValue(record, field) === true);
            return this.result(
                eligible,
                eligible ? 'ok' : 'not-found',
                eligible
                    ? 'Discord sponsor verification succeeded.'
                    : 'Discord sponsor verification is required before this game account can be created.',
                record
            );
        } catch (err) {
            console.warn(`[SponsorEligibility] Mongo sponsor check failed: ${(err as Error).message}`);
            return this.result(
                false,
                'query-failed',
                'Sponsor verification could not be checked. Try again later.'
            );
        }
    }

    private async getCollection(): Promise<Collection<SponsorDocument>> {
        if (this.collection) {
            return this.collection;
        }

        const client = new MongoClient(Config.SPONSOR_MONGODB_URI, { ignoreUndefined: true });
        await client.connect();
        this.client = client;
        this.collection = client
            .db(Config.SPONSOR_MONGODB_DB_NAME)
            .collection<SponsorDocument>(Config.SPONSOR_MONGODB_COLLECTION);
        return this.collection;
    }

    private buildSponsorFilter(discordId: string): Record<string, unknown> {
        return {
            $and: [
                { $or: this.discordIdFields.map((field) => ({ [field]: discordId })) },
                { $or: this.statusFields.map((field) => ({ [field]: true })) }
            ]
        };
    }

    private result(
        eligible: boolean,
        reason: SponsorEligibilityResult['reason'],
        message: string,
        record?: SponsorDocument
    ): SponsorEligibilityResult {
        return {
            eligible,
            reason,
            message,
            metadata: {
                sponsorEligible: eligible,
                sponsorStatus: eligible ? 'active' : 'none',
                sponsorSource: this.isConfigured()
                    ? `mongodb:${Config.SPONSOR_MONGODB_DB_NAME}.${Config.SPONSOR_MONGODB_COLLECTION}`
                    : 'unconfigured',
                sponsorCheckedAt: new Date().toISOString(),
                sponsorRecordId: normalizeSponsorRecordId(record)
            }
        };
    }
}
