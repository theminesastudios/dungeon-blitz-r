import { createHash, timingSafeEqual } from 'crypto';
import type express from 'express';
import { StaticServer } from '../core/StaticServer';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { JsonAdapter } from '../database/JsonAdapter';
import type { Character } from '../database/Database';

const MAX_MAINTENANCE_WARNING_SECONDS = 86_400;
const FAILED_AUTH_RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const FAILED_AUTH_RATE_LIMIT_MAX_REQUESTS = 10;
const ADMIN_COMMAND_RATE_LIMIT_WINDOW_MS = 60_000;
const MAINTENANCE_RATE_LIMIT_MAX_REQUESTS = 3;
const IDOL_RATE_LIMIT_MAX_REQUESTS = 20;
const IDOL_TARGET_RATE_LIMIT_MAX_REQUESTS = 5;
const registeredApps = new WeakSet<express.Application>();
const db = new JsonAdapter();

type CharacterStore = Pick<JsonAdapter, 'loadCharacters' | 'saveCharacterSnapshot'>;

export type AdminRateLimitResult = {
    allowed: boolean;
    limit: number;
    remaining: number;
    resetSeconds: number;
    retryAfterSeconds: number;
};

export class DiscordAdminRateLimiter {
    private readonly entries = new Map<string, { timestamps: number[]; windowMs: number }>();
    private readonly maxKeys: number;

    constructor(maxKeys: number = 1_000) {
        this.maxKeys = Math.max(10, Math.round(Number(maxKeys) || 1_000));
    }

    consume(key: string, limit: number, windowMs: number, now: number = Date.now()): AdminRateLimitResult {
        const normalizedKey = String(key || 'unknown');
        const normalizedLimit = Math.max(1, Math.round(Number(limit) || 1));
        const normalizedWindowMs = Math.max(1_000, Math.round(Number(windowMs) || 1_000));
        const cutoff = now - normalizedWindowMs;
        const current = this.entries.get(normalizedKey);
        const timestamps = (current?.timestamps ?? []).filter((timestamp) => timestamp > cutoff);

        if (!current && this.entries.size >= this.maxKeys) {
            this.prune(now, true);
        }

        if (timestamps.length >= normalizedLimit) {
            const retryAfterSeconds = Math.max(1, Math.ceil((timestamps[0] + normalizedWindowMs - now) / 1_000));
            this.entries.set(normalizedKey, { timestamps, windowMs: normalizedWindowMs });
            return {
                allowed: false,
                limit: normalizedLimit,
                remaining: 0,
                resetSeconds: retryAfterSeconds,
                retryAfterSeconds
            };
        }

        timestamps.push(now);
        this.entries.set(normalizedKey, { timestamps, windowMs: normalizedWindowMs });
        if (this.entries.size > this.maxKeys) {
            this.prune(now, true);
        }
        const resetSeconds = Math.max(1, Math.ceil((timestamps[0] + normalizedWindowMs - now) / 1_000));
        return {
            allowed: true,
            limit: normalizedLimit,
            remaining: Math.max(0, normalizedLimit - timestamps.length),
            resetSeconds,
            retryAfterSeconds: 0
        };
    }

    private prune(now: number, enforceSize: boolean): void {
        for (const [key, entry] of this.entries) {
            const cutoff = now - entry.windowMs;
            entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > cutoff);
            if (entry.timestamps.length === 0) {
                this.entries.delete(key);
            }
        }

        if (!enforceSize || this.entries.size < this.maxKeys) {
            return;
        }
        const oldest = [...this.entries.entries()]
            .sort((left, right) => (left[1].timestamps.at(-1) ?? 0) - (right[1].timestamps.at(-1) ?? 0));
        const removeCount = this.entries.size - this.maxKeys + 1;
        for (let index = 0; index < removeCount; index++) {
            this.entries.delete(oldest[index]?.[0] ?? '');
        }
    }
}

function readBearerToken(authorization: string | undefined): string {
    const value = String(authorization ?? '').trim();
    if (value.length <= 7 || value.slice(0, 7).toLowerCase() !== 'bearer ') {
        return '';
    }
    return value.slice(7).trim();
}

function secretsMatch(provided: string, expected: string): boolean {
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

function writeRateLimitHeaders(res: express.Response, result: AdminRateLimitResult): void {
    res.setHeader('RateLimit-Limit', String(result.limit));
    res.setHeader('RateLimit-Remaining', String(result.remaining));
    res.setHeader('RateLimit-Reset', String(result.resetSeconds));
    if (!result.allowed) {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
    }
}

function getRemoteAddress(req: express.Request): string {
    return String(req.socket.remoteAddress ?? req.ip ?? 'unknown').trim().toLowerCase() || 'unknown';
}

function getCredentialFingerprint(req: express.Request): string {
    return createHash('sha256').update(readBearerToken(req.headers.authorization)).digest('hex').slice(0, 16);
}

export function requireAdminAuthorization(limiter: DiscordAdminRateLimiter): express.RequestHandler {
    return (req, res, next): void => {
        const configuredSecrets = [
            process.env.ADMIN_API_SECRET,
            process.env.DISCORD_MAINTENANCE_API_SECRET
        ].map((value) => String(value ?? '').trim()).filter(Boolean);
        if (configuredSecrets.length === 0) {
            res.status(503).json({ error: 'Discord admin API is not configured.' });
            return;
        }

        const providedSecret = readBearerToken(req.headers.authorization);
        if (providedSecret && configuredSecrets.some((secret) => secretsMatch(providedSecret, secret))) {
            next();
            return;
        }

        const result = limiter.consume(
            `failed-auth:${getRemoteAddress(req)}`,
            FAILED_AUTH_RATE_LIMIT_MAX_REQUESTS,
            FAILED_AUTH_RATE_LIMIT_WINDOW_MS
        );
        writeRateLimitHeaders(res, result);
        if (!result.allowed) {
            res.status(429).json({ error: 'Too many failed admin authorization attempts.' });
            return;
        }
        res.status(401).json({ error: 'Unauthorized.' });
    };
}

function commandRateLimit(
    limiter: DiscordAdminRateLimiter,
    command: 'maintenance' | 'idols',
    limit: number,
    targetKey?: (req: express.Request) => string
): express.RequestHandler {
    return (req, res, next): void => {
        const fingerprint = getCredentialFingerprint(req);
        const commandResult = limiter.consume(
            `command:${command}:${fingerprint}`,
            limit,
            ADMIN_COMMAND_RATE_LIMIT_WINDOW_MS
        );
        writeRateLimitHeaders(res, commandResult);
        if (!commandResult.allowed) {
            res.status(429).json({ error: `Too many ${command} admin requests.` });
            return;
        }

        if (targetKey) {
            const normalizedTarget = targetKey(req);
            const targetResult = limiter.consume(
                `target:${command}:${fingerprint}:${normalizedTarget}`,
                IDOL_TARGET_RATE_LIMIT_MAX_REQUESTS,
                ADMIN_COMMAND_RATE_LIMIT_WINDOW_MS
            );
            if (!targetResult.allowed || targetResult.remaining < commandResult.remaining) {
                writeRateLimitHeaders(res, targetResult);
            }
            if (!targetResult.allowed) {
                res.status(429).json({ error: 'Too many admin requests for this player character.' });
                return;
            }
        }

        next();
    };
}

function normalizeCharacterName(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

function normalizeIdolBalance(value: unknown): number {
    const balance = Number(value ?? 0);
    return Number.isFinite(balance) ? Math.max(0, Math.round(balance)) : 0;
}

function sendMammothIdolUpdate(session: { character?: Character | null; sendBitBuffer: (packetId: number, payload: BitBuffer) => void }): void {
    if (!session.character) {
        return;
    }

    const bb = new BitBuffer(false);
    bb.writeMethod4(normalizeIdolBalance(session.character.mammothIdols));
    bb.writeMethod4(0);
    bb.writeMethod11(session.character.showHigher ? 1 : 0, 1);
    session.sendBitBuffer(0xA1, bb);
}

export function broadcastMaintenanceWarning(seconds: number): number {
    if (
        !Number.isSafeInteger(seconds) ||
        seconds < 1 ||
        seconds > MAX_MAINTENANCE_WARNING_SECONDS
    ) {
        throw new RangeError(
            `Maintenance seconds must be between 1 and ${MAX_MAINTENANCE_WARNING_SECONDS}.`
        );
    }

    const warning = new BitBuffer(false);
    warning.writeMethod4(seconds);
    const payload = warning.toBuffer();
    const announcement = `Server maintenance starts in ${seconds} second${seconds === 1 ? '' : 's'}.`;
    let recipients = 0;

    for (const session of GlobalState.sessionsByToken.values()) {
        if (!GlobalState.isClientConnectionOpen(session)) {
            continue;
        }

        session.send(0x101, payload);
        const status = new BitBuffer(false);
        status.writeMethod13(announcement);
        session.sendBitBuffer(0x44, status);
        recipients += 1;
    }

    return recipients;
}

export async function adjustMammothIdols(
    userId: number,
    characterName: string,
    operation: 'add' | 'sub',
    amount: number,
    store: CharacterStore = db
): Promise<{ before: number; after: number; onlineRecipients: number } | null> {
    const normalizedName = normalizeCharacterName(characterName);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !normalizedName) {
        return null;
    }

    const accountSessions = GlobalState.getActiveSessionsByUserId(userId).filter((session) =>
        GlobalState.isClientConnectionOpen(session)
    );
    const targetSessions = accountSessions.filter((session) =>
        normalizeCharacterName(session.character?.name) === normalizedName
    );
    const storedCharacters = await store.loadCharacters(userId);
    const authoritativeCharacter = targetSessions[0]?.character ?? storedCharacters.find((character) =>
        normalizeCharacterName(character?.name) === normalizedName
    );
    if (!authoritativeCharacter) {
        return null;
    }

    const before = normalizeIdolBalance(authoritativeCharacter.mammothIdols);
    if (operation === 'sub' && before < amount) {
        return { before, after: before, onlineRecipients: -1 };
    }
    const after = operation === 'add' ? before + amount : before - amount;

    const mutatedCharacters = new Map<Character, number | undefined>();
    const setBalance = (character: Character | null | undefined): void => {
        if (!character || normalizeCharacterName(character.name) !== normalizedName) {
            return;
        }
        if (!mutatedCharacters.has(character)) {
            mutatedCharacters.set(character, character.mammothIdols);
        }
        character.mammothIdols = after;
    };

    setBalance(authoritativeCharacter);
    for (const session of accountSessions) {
        setBalance(session.character);
        const listedCharacter = session.characters.find((character) =>
            normalizeCharacterName(character?.name) === normalizedName
        );
        setBalance(listedCharacter);
    }

    let savedCharacters: Character[];
    try {
        savedCharacters = await store.saveCharacterSnapshot(userId, {
            ...authoritativeCharacter,
            mammothIdols: after
        });
    } catch (error) {
        for (const [character, previousBalance] of mutatedCharacters) {
            character.mammothIdols = previousBalance;
        }
        throw error;
    }

    for (const session of accountSessions) {
        session.characters = savedCharacters;
    }
    for (const session of targetSessions) {
        sendMammothIdolUpdate(session);
    }

    return { before, after, onlineRecipients: targetSessions.length };
}

export function registerDiscordMaintenanceApi(staticServer: StaticServer): void {
    const app = (staticServer as unknown as { app: express.Application }).app;
    if (registeredApps.has(app)) {
        return;
    }
    registeredApps.add(app);
    const limiter = new DiscordAdminRateLimiter();
    const authorize = requireAdminAuthorization(limiter);

    app.post(
        '/api/admin/maintenance',
        authorize,
        commandRateLimit(limiter, 'maintenance', MAINTENANCE_RATE_LIMIT_MAX_REQUESTS),
        (req, res) => {
            res.setHeader('Cache-Control', 'no-store');

            const body = req.body && typeof req.body === 'object'
                ? req.body as Record<string, unknown>
                : {};
            const seconds = Number(body.seconds);
            if (
                !Number.isSafeInteger(seconds) ||
                seconds < 1 ||
                seconds > MAX_MAINTENANCE_WARNING_SECONDS
            ) {
                res.status(400).json({
                    error: `seconds must be an integer between 1 and ${MAX_MAINTENANCE_WARNING_SECONDS}.`
                });
                return;
            }

            const recipients = broadcastMaintenanceWarning(seconds);
            console.log(`[MaintenanceAPI] Broadcast ${seconds}s warning to ${recipients} connected player(s).`);
            res.json({ ok: true, seconds, recipients });
        }
    );

    app.post(
        '/api/admin/idols',
        authorize,
        commandRateLimit(
            limiter,
            'idols',
            IDOL_RATE_LIMIT_MAX_REQUESTS,
            (req) => `${Math.max(0, Math.round(Number(req.body?.userId ?? 0)))}:${normalizeCharacterName(req.body?.characterName)}`
        ),
        async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');

            const body = req.body && typeof req.body === 'object'
                ? req.body as Record<string, unknown>
                : {};
            const userId = Number(body.userId);
            const characterName = String(body.characterName ?? '').trim();
            const operation = String(body.operation ?? '') as 'add' | 'sub';
            const amount = Number(body.amount);
            if (
                !Number.isSafeInteger(userId) ||
                userId <= 0 ||
                !characterName ||
                (operation !== 'add' && operation !== 'sub') ||
                !Number.isSafeInteger(amount) ||
                amount <= 0
            ) {
                res.status(400).json({ error: 'Invalid userId, characterName, operation, or amount.' });
                return;
            }

            try {
                const result = await adjustMammothIdols(userId, characterName, operation, amount);
                if (!result) {
                    res.status(404).json({ error: 'Player character was not found.' });
                    return;
                }
                if (result.onlineRecipients < 0) {
                    res.status(409).json({ error: 'The player does not have enough Mammoth Idols.' });
                    return;
                }

                console.log(
                    `[MaintenanceAPI] ${operation === 'add' ? 'Added' : 'Subtracted'} ${amount} Mammoth Idols ` +
                    `for ${characterName} (${userId}): ${result.before} -> ${result.after}; ` +
                    `onlineRecipients=${result.onlineRecipients}`
                );
                res.json({
                    ok: true,
                    userId,
                    characterName,
                    operation,
                    amount,
                    before: result.before,
                    after: result.after,
                    onlineRecipients: result.onlineRecipients
                });
            } catch (error) {
                console.error('[MaintenanceAPI] Idol adjustment failed:', error);
                res.status(500).json({ error: 'The Mammoth Idol adjustment failed.' });
            }
        }
    );
}
