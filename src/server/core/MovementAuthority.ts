import { LevelConfig } from './LevelConfig';

export interface MovementAuthorityState {
    lastAcceptedX: number;
    lastAcceptedY: number;
    lastAcceptedAtMs: number;
    speedViolationScore: number;
    lastMovementResetReason: string;
    movementQuarantineUntilMs: number;
}

export interface MovementAuthorityClient {
    userId: number | null;
    token: number;
    character: { name?: string; equippedMount?: unknown } | null;
    currentLevel: string;
    movementAuthority: MovementAuthorityState;
    pendingTransferUntil: number;
    mountTransferGraceUntil: number;
    activeDungeonCutsceneScope: string;
    clientEntID: number;
    socket?: { destroy?: () => void };
}

export interface MovementValidationResult {
    accepted: boolean;
    reason: string;
    attemptedX: number;
    attemptedY: number;
    lastAcceptedX: number;
    lastAcceptedY: number;
    elapsedMs: number;
    allowedDistance: number;
    actualDistance: number;
    speedViolationScore: number;
    quarantine: boolean;
    disconnect: boolean;
}

export class MovementAuthority {
    private static readonly BASE_PLAYER_SPEED_PER_SECOND = 900;
    private static readonly MOUNT_SPEED_MULTIPLIER = 1.45;
    private static readonly MAX_SPEED_MOD_MULTIPLIER = 2.5;
    private static readonly MIN_FRAME_MS = 16;
    private static readonly SHORT_FRAME_TOLERANCE_MS = 24;
    private static readonly LAG_TOLERANCE_MS = 250;
    private static readonly POSITION_TOLERANCE = 90;
    private static readonly MAX_SINGLE_PACKET_DISTANCE = 2600;
    private static readonly TRANSFER_GRACE_MAX_DISTANCE = 12000;
    private static readonly QUARANTINE_SCORE = 8;
    private static readonly DISCONNECT_SCORE = 16;
    private static readonly QUARANTINE_MS = 5000;

    static createState(reason: string = 'init'): MovementAuthorityState {
        return {
            lastAcceptedX: 0,
            lastAcceptedY: 0,
            lastAcceptedAtMs: 0,
            speedViolationScore: 0,
            lastMovementResetReason: reason,
            movementQuarantineUntilMs: 0
        };
    }

    static reset(
        client: Pick<MovementAuthorityClient, 'movementAuthority'>,
        reason: string,
        x: number | null | undefined = null,
        y: number | null | undefined = null,
        nowMs: number = Date.now()
    ): void {
        const state = client.movementAuthority ?? MovementAuthority.createState(reason);
        state.lastAcceptedX = MovementAuthority.normalizeCoordinate(x ?? state.lastAcceptedX);
        state.lastAcceptedY = MovementAuthority.normalizeCoordinate(y ?? state.lastAcceptedY);
        state.lastAcceptedAtMs = Math.max(0, Math.round(nowMs));
        state.speedViolationScore = 0;
        state.lastMovementResetReason = reason;
        state.movementQuarantineUntilMs = 0;
        client.movementAuthority = state;
    }

    static resetFromEntity(
        client: Pick<MovementAuthorityClient, 'movementAuthority'>,
        entity: { x?: unknown; y?: unknown } | null | undefined,
        reason: string,
        nowMs: number = Date.now()
    ): void {
        MovementAuthority.reset(
            client,
            reason,
            MovementAuthority.normalizeCoordinate(entity?.x),
            MovementAuthority.normalizeCoordinate(entity?.y),
            nowMs
        );
    }

    static validateIncrementalMovement(
        client: MovementAuthorityClient,
        entity: { x?: unknown; y?: unknown; behaviorSpeedMod?: unknown; equippedMount?: unknown } | null | undefined,
        deltaX: number,
        deltaY: number,
        nowMs: number = Date.now()
    ): MovementValidationResult {
        const state = client.movementAuthority ?? MovementAuthority.createState('init');
        client.movementAuthority = state;

        const currentX = MovementAuthority.normalizeCoordinate(entity?.x);
        const currentY = MovementAuthority.normalizeCoordinate(entity?.y);
        const attemptedX = currentX + MovementAuthority.normalizeCoordinate(deltaX);
        const attemptedY = currentY + MovementAuthority.normalizeCoordinate(deltaY);
        const elapsedMs = state.lastAcceptedAtMs > 0
            ? Math.max(0, Math.round(nowMs - state.lastAcceptedAtMs))
            : 0;
        const actualDistance = Math.hypot(attemptedX - state.lastAcceptedX, attemptedY - state.lastAcceptedY);

        if (state.lastAcceptedAtMs <= 0) {
            MovementAuthority.accept(state, attemptedX, attemptedY, nowMs, 'first_movement');
            return MovementAuthority.result(true, 'first_movement', attemptedX, attemptedY, state, elapsedMs, 0, actualDistance);
        }

        if (nowMs < state.movementQuarantineUntilMs) {
            return MovementAuthority.reject(
                client,
                state,
                'movement_quarantined',
                attemptedX,
                attemptedY,
                elapsedMs,
                0,
                actualDistance,
                nowMs
            );
        }

        if (MovementAuthority.hasTransitionGrace(client, nowMs)) {
            const allowedDistance = MovementAuthority.TRANSFER_GRACE_MAX_DISTANCE;
            if (actualDistance <= allowedDistance) {
                MovementAuthority.accept(state, attemptedX, attemptedY, nowMs, 'transition_grace');
                return MovementAuthority.result(true, 'transition_grace', attemptedX, attemptedY, state, elapsedMs, allowedDistance, actualDistance);
            }
        }

        const allowedDistance = MovementAuthority.getAllowedDistance(client, entity, elapsedMs);
        if (actualDistance > MovementAuthority.MAX_SINGLE_PACKET_DISTANCE) {
            return MovementAuthority.reject(
                client,
                state,
                'teleport_delta',
                attemptedX,
                attemptedY,
                elapsedMs,
                Math.min(allowedDistance, MovementAuthority.MAX_SINGLE_PACKET_DISTANCE),
                actualDistance,
                nowMs
            );
        }

        if (actualDistance > allowedDistance) {
            return MovementAuthority.reject(
                client,
                state,
                'speed_delta',
                attemptedX,
                attemptedY,
                elapsedMs,
                allowedDistance,
                actualDistance,
                nowMs
            );
        }

        MovementAuthority.accept(state, attemptedX, attemptedY, nowMs, 'accepted');
        return MovementAuthority.result(true, 'accepted', attemptedX, attemptedY, state, elapsedMs, allowedDistance, actualDistance);
    }

    private static getAllowedDistance(
        client: MovementAuthorityClient,
        entity: { behaviorSpeedMod?: unknown; equippedMount?: unknown } | null | undefined,
        elapsedMs: number
    ): number {
        const speed = MovementAuthority.getAllowedSpeed(client, entity);
        const toleranceMs = elapsedMs < 120
            ? MovementAuthority.SHORT_FRAME_TOLERANCE_MS
            : MovementAuthority.LAG_TOLERANCE_MS;
        const effectiveElapsedMs = Math.max(MovementAuthority.MIN_FRAME_MS, elapsedMs) + toleranceMs;

        return Math.round((speed * effectiveElapsedMs) / 1000 + MovementAuthority.POSITION_TOLERANCE);
    }

    private static getAllowedSpeed(
        client: MovementAuthorityClient,
        entity: { behaviorSpeedMod?: unknown; equippedMount?: unknown } | null | undefined
    ): number {
        let multiplier = 1;
        const speedMod = Number(entity?.behaviorSpeedMod ?? 0);
        if (Number.isFinite(speedMod) && speedMod > 0) {
            multiplier = Math.max(multiplier, Math.min(MovementAuthority.MAX_SPEED_MOD_MULTIPLIER, speedMod));
        }

        const equippedMount = entity?.equippedMount ?? client.character?.equippedMount;
        if (Number(equippedMount ?? 0) > 0) {
            multiplier = Math.max(multiplier, MovementAuthority.MOUNT_SPEED_MULTIPLIER);
        }

        return MovementAuthority.BASE_PLAYER_SPEED_PER_SECOND * multiplier;
    }

    private static hasTransitionGrace(client: MovementAuthorityClient, nowMs: number): boolean {
        return nowMs < Number(client.pendingTransferUntil ?? 0) ||
            nowMs < Number(client.mountTransferGraceUntil ?? 0) ||
            Boolean(String(client.activeDungeonCutsceneScope ?? '').trim()) ||
            LevelConfig.normalizeLevelName(client.currentLevel) === 'TutorialBoat';
    }

    private static accept(
        state: MovementAuthorityState,
        x: number,
        y: number,
        nowMs: number,
        reason: string
    ): void {
        state.lastAcceptedX = MovementAuthority.normalizeCoordinate(x);
        state.lastAcceptedY = MovementAuthority.normalizeCoordinate(y);
        state.lastAcceptedAtMs = Math.max(0, Math.round(nowMs));
        state.speedViolationScore = Math.max(0, state.speedViolationScore - 1);
        state.lastMovementResetReason = reason;
    }

    private static reject(
        client: MovementAuthorityClient,
        state: MovementAuthorityState,
        reason: string,
        attemptedX: number,
        attemptedY: number,
        elapsedMs: number,
        allowedDistance: number,
        actualDistance: number,
        nowMs: number
    ): MovementValidationResult {
        state.speedViolationScore += reason === 'teleport_delta' ? 4 : 2;
        const quarantine = state.speedViolationScore >= MovementAuthority.QUARANTINE_SCORE;
        const disconnect = state.speedViolationScore >= MovementAuthority.DISCONNECT_SCORE;
        if (quarantine) {
            state.movementQuarantineUntilMs = Math.max(
                state.movementQuarantineUntilMs,
                nowMs + MovementAuthority.QUARANTINE_MS
            );
        }

        MovementAuthority.logSuspiciousMovement(client, reason, attemptedX, attemptedY, elapsedMs, allowedDistance, actualDistance);
        if (disconnect) {
            client.socket?.destroy?.();
        }

        return {
            ...MovementAuthority.result(false, reason, attemptedX, attemptedY, state, elapsedMs, allowedDistance, actualDistance),
            quarantine,
            disconnect
        };
    }

    private static result(
        accepted: boolean,
        reason: string,
        attemptedX: number,
        attemptedY: number,
        state: MovementAuthorityState,
        elapsedMs: number,
        allowedDistance: number,
        actualDistance: number
    ): MovementValidationResult {
        return {
            accepted,
            reason,
            attemptedX,
            attemptedY,
            lastAcceptedX: state.lastAcceptedX,
            lastAcceptedY: state.lastAcceptedY,
            elapsedMs,
            allowedDistance,
            actualDistance,
            speedViolationScore: state.speedViolationScore,
            quarantine: false,
            disconnect: false
        };
    }

    private static normalizeCoordinate(value: unknown): number {
        const numeric = Number(value ?? 0);
        return Number.isFinite(numeric) ? Math.round(numeric) : 0;
    }

    private static logSuspiciousMovement(
        client: MovementAuthorityClient,
        reason: string,
        attemptedX: number,
        attemptedY: number,
        elapsedMs: number,
        allowedDistance: number,
        actualDistance: number
    ): void {
        const state = client.movementAuthority;
        console.warn(
            `[MovementAuthority] rejected reason=${reason} userId=${client.userId ?? 0} ` +
            `character=${String(client.character?.name ?? 'unknown').replace(/\s+/g, '_')} ` +
            `level=${LevelConfig.normalizeLevelName(client.currentLevel) || client.currentLevel || '(unknown)'} ` +
            `old=${state.lastAcceptedX},${state.lastAcceptedY} attempted=${Math.round(attemptedX)},${Math.round(attemptedY)} ` +
            `elapsedMs=${elapsedMs} allowed=${Math.round(allowedDistance)} actual=${Math.round(actualDistance)} ` +
            `score=${state.speedViolationScore} reset=${state.lastMovementResetReason}`
        );
    }
}
