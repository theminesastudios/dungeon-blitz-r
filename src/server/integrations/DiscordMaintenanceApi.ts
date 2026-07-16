import { timingSafeEqual } from 'crypto';
import type express from 'express';
import { StaticServer } from '../core/StaticServer';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';

const MAX_MAINTENANCE_WARNING_SECONDS = 86_400;
const registeredApps = new WeakSet<express.Application>();

function readBearerToken(authorization: string | undefined): string {
    const match = /^Bearer\s+(.+)$/i.exec(String(authorization ?? '').trim());
    return match?.[1]?.trim() ?? '';
}

function secretsMatch(provided: string, expected: string): boolean {
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
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

export function registerDiscordMaintenanceApi(staticServer: StaticServer): void {
    const app = (staticServer as unknown as { app: express.Application }).app;
    if (registeredApps.has(app)) {
        return;
    }
    registeredApps.add(app);

    app.post('/api/admin/maintenance', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');

        const configuredSecret = String(process.env.DISCORD_MAINTENANCE_API_SECRET ?? '').trim();
        if (!configuredSecret) {
            res.status(503).json({ error: 'Maintenance API is not configured.' });
            return;
        }

        const providedSecret = readBearerToken(req.headers.authorization);
        if (!providedSecret || !secretsMatch(providedSecret, configuredSecret)) {
            res.status(401).json({ error: 'Unauthorized.' });
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
}
