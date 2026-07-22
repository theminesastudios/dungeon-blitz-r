import type express from 'express';
import { StaticServer } from '../core/StaticServer';
import { GlobalState } from '../core/GlobalState';
import { AdminRuntimeSettings } from '../core/AdminRuntimeSettings';
import { DiscordAdminRateLimiter, requireAdminAuthorization } from './DiscordMaintenanceApi';
import { getClientLevelScope } from '../core/LevelScope';
import { EntityState, EntityTeam } from '../core/Entity';
import { getRoomBossAwareRoomId } from '../core/RoomBossState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { CombatHandler } from '../handlers/CombatHandler';
import { MovementAuthority } from '../core/MovementAuthority';

const registeredApps = new WeakSet<express.Application>();

function activeSessions() {
    return [...GlobalState.sessionsByToken.values()]
        .filter((session) => session.playerSpawned && GlobalState.isClientConnectionOpen(session));
}

function countRoomHostiles(levelScope: string, roomId: number): number {
    const hostileIds = new Set<number>();
    const collect = (entity: any): void => {
        const entityId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        const dead = Boolean(entity?.dead) || Boolean(entity?.destroyed) ||
            Number(entity?.entState ?? EntityState.ACTIVE) === EntityState.DEAD ||
            (Number.isFinite(Number(entity?.hp)) && Number(entity.hp) <= 0);
        if (
            entityId > 0 &&
            entity &&
            !entity.isPlayer &&
            Number(entity.team ?? 0) === EntityTeam.ENEMY &&
            getRoomBossAwareRoomId(entity) === roomId &&
            !dead
        ) {
            hostileIds.add(entityId);
        }
    };
    for (const entity of GlobalState.levelEntities.get(levelScope)?.values() ?? []) {
        collect(entity);
    }
    for (const session of GlobalState.getSessionsInLevelScope(levelScope)) {
        for (const entity of session.entities.values()) {
            collect(entity);
        }
    }
    return hostileIds.size;
}

export function buildAdminSnapshot() {
    const sessions = activeSessions();
    const rooms = new Map<string, {
        key: string;
        levelScope: string;
        level: string;
        roomId: number;
        players: number;
        hostiles: number;
    }>();

    const players = sessions.map((session) => {
        const levelScope = getClientLevelScope(session);
        const roomId = Math.round(Number(session.currentRoomId ?? -1));
        const roomKey = `${levelScope}:${roomId}`;
        const room = rooms.get(roomKey) ?? {
            key: roomKey,
            levelScope,
            level: session.currentLevel,
            roomId,
            players: 0,
            hostiles: countRoomHostiles(levelScope, roomId)
        };
        room.players += 1;
        rooms.set(roomKey, room);

        return {
            token: session.token,
            userId: session.userId,
            name: String(session.character?.name ?? ''),
            className: String(session.character?.class ?? ''),
            level: session.currentLevel,
            levelScope,
            roomId,
            partyId: GlobalState.partyByMember.get(String(session.character?.name ?? '').trim().toLowerCase()) ?? 0,
            hp: Math.max(0, Math.round(Number(session.authoritativeCurrentHp ?? 0))),
            maxHp: Math.max(1, Math.round(Number(session.authoritativeMaxHp ?? 1))),
            speedMultiplier: Number((session as unknown as { movementSpeedMultiplier?: number }).movementSpeedMultiplier ?? 1),
            connectedAt: session.playSessionStartedAt
        };
    });

    return {
        ok: true,
        generatedAt: Date.now(),
        uptimeSeconds: Math.round(process.uptime()),
        connections: GlobalState.clients.size,
        onlinePlayers: players.length,
        settings: AdminRuntimeSettings.snapshot,
        players,
        rooms: [...rooms.values()].sort((a, b) => a.level.localeCompare(b.level) || a.roomId - b.roomId)
    };
}

function sendSpeed(session: ReturnType<typeof activeSessions>[number], multiplier: number): void {
    (session as unknown as { movementSpeedMultiplier: number }).movementSpeedMultiplier = multiplier;
    const entity = session.entities.get(session.clientEntID);
    if (entity && typeof entity === 'object') {
        entity.behaviorSpeedMod = multiplier;
    }
    MovementAuthority.resetFromEntity(session, entity, 'admin_speed_change');
    if (session.clientEntID > 0) {
        const payload = new BitBuffer(false);
        payload.writeMethod4(session.clientEntID);
        payload.writeMethod4(Math.round(multiplier * 10_000));
        session.sendBitBuffer(0x8A, payload);
    }
}

function healSession(session: ReturnType<typeof activeSessions>[number]): number {
    const maxHp = Math.max(1, Math.round(Number(session.authoritativeMaxHp ?? 1)));
    const currentHp = Math.max(0, Math.min(maxHp, Math.round(Number(session.authoritativeCurrentHp ?? maxHp))));
    const healed = maxHp - currentHp;
    session.authoritativeCurrentHp = maxHp;
    const entity = session.entities.get(session.clientEntID);
    if (entity && typeof entity === 'object') {
        entity.maxHp = maxHp;
        entity.hp = maxHp;
        entity.dead = false;
        entity.entState = EntityState.ACTIVE;
    }
    if (healed > 0 && session.clientEntID > 0) {
        const payload = new BitBuffer(false);
        payload.writeMethod4(session.clientEntID);
        payload.writeMethod45(healed);
        session.sendBitBuffer(0x78, payload);
    }
    return healed;
}

function broadcastAnnouncement(message: string): number {
    let recipients = 0;
    for (const session of activeSessions()) {
        const payload = new BitBuffer(false);
        payload.writeMethod13(message);
        session.sendBitBuffer(0x44, payload);
        recipients += 1;
    }
    return recipients;
}

export function registerAdminControlApi(staticServer: StaticServer): void {
    const app = (staticServer as unknown as { app: express.Application }).app;
    if (registeredApps.has(app)) {
        return;
    }
    registeredApps.add(app);

    const authorize = requireAdminAuthorization(new DiscordAdminRateLimiter());
    app.get('/api/admin/control/snapshot', authorize, (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json(buildAdminSnapshot());
    });

    app.get('/api/admin/control/events', authorize, (req, res) => {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        const publish = (): void => {
            res.write(`event: snapshot\ndata: ${JSON.stringify(buildAdminSnapshot())}\n\n`);
        };
        publish();
        const interval = setInterval(publish, 1_000);
        req.on('close', () => clearInterval(interval));
    });

    app.patch('/api/admin/control/settings', authorize, (req, res) => {
        try {
            const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
            const settings = AdminRuntimeSettings.update(body);
            for (const session of activeSessions()) {
                sendSpeed(session, settings.playerSpeedMultiplier);
            }
            console.log(`[AdminPanel] Runtime settings updated revision=${settings.revision}.`);
            res.json({ ok: true, settings });
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid settings.' });
        }
    });

    app.post('/api/admin/control/reset', authorize, (_req, res) => {
        const settings = AdminRuntimeSettings.reset();
        for (const session of activeSessions()) {
            sendSpeed(session, settings.playerSpeedMultiplier);
        }
        res.json({ ok: true, settings });
    });

    app.post('/api/admin/control/action', authorize, (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
        const action = String(body.action ?? '').trim();
        const token = Math.max(0, Math.round(Number(body.token ?? 0)));
        const target = token > 0 ? GlobalState.sessionsByToken.get(token) : null;

        if (action === 'kill-room') {
            if (!target || !target.playerSpawned) {
                res.status(404).json({ error: 'Target player session was not found.' });
                return;
            }
            const result = CombatHandler.adminDefeatRoomHostiles(target, Number(body.roomId ?? target.currentRoomId));
            console.log(`[AdminPanel] Defeated ${result.defeated} hostile(s) in ${target.currentLevel} room ${result.roomId}.`);
            res.json({ ok: true, ...result });
            return;
        }

        if (action === 'heal-player' || action === 'heal-all') {
            const targets = action === 'heal-all' ? activeSessions() : target ? [target] : [];
            if (targets.length === 0) {
                res.status(404).json({ error: 'No matching online player was found.' });
                return;
            }
            const healed = targets.reduce((total, session) => total + healSession(session), 0);
            res.json({ ok: true, players: targets.length, healed });
            return;
        }

        if (action === 'kick-player') {
            if (!target) {
                res.status(404).json({ error: 'Target player session was not found.' });
                return;
            }
            const name = String(target.character?.name ?? target.token);
            target.socket.end();
            setTimeout(() => target.socket.destroy(), 250).unref();
            console.log(`[AdminPanel] Disconnected ${name}.`);
            res.json({ ok: true, name });
            return;
        }

        if (action === 'announce') {
            const message = String(body.message ?? '').trim().slice(0, 240);
            if (!message) {
                res.status(400).json({ error: 'Announcement message is required.' });
                return;
            }
            const recipients = broadcastAnnouncement(`[ADMIN] ${message}`);
            res.json({ ok: true, recipients });
            return;
        }

        res.status(400).json({ error: 'Unknown admin action.' });
    });
}
