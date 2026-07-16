import { timingSafeEqual } from 'crypto';
import type express from 'express';
import { StaticServer } from '../core/StaticServer';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { JsonAdapter } from '../database/JsonAdapter';
import type { Character } from '../database/Database';

const MAX_MAINTENANCE_WARNING_SECONDS = 86_400;
const ADMIN_RATE_LIMIT_WINDOW_MS = 60_000;
const ADMIN_RATE_LIMIT_MAX_REQUESTS = 30;
const registeredApps = new WeakSet<express.Application>();
const adminRateLimitEntries = new Map<string, { startedAt: number; count: number }>();
const db = new JsonAdapter();

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

function adminRateLimit(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const now = Date.now();
    const key = String(req.socket.remoteAddress ?? 'unknown');
    const current = adminRateLimitEntries.get(key);
    const entry = !current || now - current.startedAt >= ADMIN_RATE_LIMIT_WINDOW_MS
        ? { startedAt: now, count: 1 }
        : { startedAt: current.startedAt, count: current.count + 1 };
    adminRateLimitEntries.set(key, entry);

    const remaining = Math.max(0, ADMIN_RATE_LIMIT_MAX_REQUESTS - entry.count);
    const resetAt = Math.ceil((entry.startedAt + ADMIN_RATE_LIMIT_WINDOW_MS) / 1000);
    res.setHeader('RateLimit-Limit', String(ADMIN_RATE_LIMIT_MAX_REQUESTS));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetAt));

    if (entry.count > ADMIN_RATE_LIMIT_MAX_REQUESTS) {
        res.setHeader('Retry-After', String(Math.max(1, resetAt - Math.floor(now / 1000))));
        res.status(429).json({ error: 'Too many admin requests.' });
        return;
    }

    if (adminRateLimitEntries.size > 1_000) {
        for (const [entryKey, candidate] of adminRateLimitEntries) {
            if (now - candidate.startedAt >= ADMIN_RATE_LIMIT_WINDOW_MS) {
                adminRateLimitEntries.delete(entryKey);
            }
        }
    }

    next();
}

function isAuthorized(req: express.Request, res: express.Response): boolean {
    const configuredSecret = String(process.env.DISCORD_MAINTENANCE_API_SECRET ?? '').trim();
    if (!configuredSecret) {
        res.status(503).json({ error: 'Discord admin API is not configured.' });
        return false;
    }

    const providedSecret = readBearerToken(req.headers.authorization);
    if (!providedSecret || !secretsMatch(providedSecret, configuredSecret)) {
        res.status(401).json({ error: 'Unauthorized.' });
        return false;
    }

    return true;
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
    let recipients = 0;

    for (const session of GlobalState.sessionsByToken.values()) {
        if (!GlobalState.isClientConnectionOpen(session)) {
            continue;
        }

        session.send(0x101, payload);
        recipients += 1;
    }

    return recipients;
}

async function adjustMammothIdols(
    userId: number,
    characterName: string,
    operation: 'add' | 'sub',
    amount: number
): Promise<{ before: number; after: number; onlineRecipients: number } | null> {
    const normalizedName = normalizeCharacterName(characterName);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !normalizedName) {
        return null;
    }

    const liveSessions = GlobalState.getActiveSessionsByUserId(userId).filter((session) =>
        GlobalState.isClientConnectionOpen(session) &&
        normalizeCharacterName(session.character?.name) === normalizedName
    );
    const storedCharacters = liveSessions.length > 0 ? [] : await db.loadCharacters(userId);
    const authoritativeCharacter = liveSessions[0]?.character ?? storedCharacters.find((character) =>
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
    authoritativeCharacter.mammothIdols = after;

    for (const session of liveSessions) {
        if (!session.character) {
            continue;
        }
        session.character.mammothIdols = after;
        const listedCharacter = session.characters.find((character) =>
            normalizeCharacterName(character?.name) === normalizedName
        );
        if (listedCharacter) {
            listedCharacter.mammothIdols = after;
        }
        sendMammothIdolUpdate(session);
    }

    const savedCharacters = await db.saveCharacterSnapshot(userId, authoritativeCharacter);
    for (const session of liveSessions) {
        session.characters = savedCharacters;
    }

    return { before, after, onlineRecipients: liveSessions.length };
}

export function registerDiscordMaintenanceApi(staticServer: StaticServer): void {
    const app = (staticServer as unknown as { app: express.Application }).app;
    if (registeredApps.has(app)) {
        return;
    }
    registeredApps.add(app);

    app.post('/api/admin/maintenance', adminRateLimit, (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!isAuthorized(req, res)) {
            return;
        }

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
    });

    app.post('/api/admin/idols', adminRateLimit, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!isAuthorized(req, res)) {
            return;
        }

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
    });
}
