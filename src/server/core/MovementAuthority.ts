import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { LevelConfig } from './LevelConfig';
import { resolveClientXmlDir } from '../utils/ClientXmlDir';

export interface MovementAuthorityState {
    lastAcceptedX: number;
    lastAcceptedY: number;
    lastAcceptedAtMs: number;
    movementBudgetDistance: number;
    movementBudgetUpdatedAtMs: number;
    speedViolationScore: number;
    lastMovementResetReason: string;
    movementQuarantineUntilMs: number;
    correctionGraceUntilMs: number;
    mobilityGraceUntilMs: number;
    mobilityRemainingDistance: number;
    mobilityPowerId: number;
}

export interface MovementAuthorityClient {
    userId: number | null;
    token: number;
    character: { name?: string; equippedMount?: unknown } | null;
    currentLevel: string;
    movementAuthority: MovementAuthorityState;
    pendingTransferUntil: number;
    mountTransferGraceUntil: number;
    roomTransitionGraceUntil: number;
    activeDungeonCutsceneScope: string;
    clientEntID: number;
    movementSpeedMultiplier?: number;
    movementRootUntilMs?: number;
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

export interface MovementClampResult {
    clamped: boolean;
    x: number;
    y: number;
}

export class MovementAuthority {
    private static readonly BASE_PLAYER_SPEED_PER_SECOND = 900;
    private static readonly MOUNT_SPEED_MULTIPLIER = 1.45;
    private static readonly MAX_BUDGET_MS = 1000;
    // Dungeon clients can go several seconds without emitting a movement sample
    // while room scripts, cinematics and local summons run. Judge those sparse
    // samples over a longer (still bounded) window instead of treating six
    // seconds of ordinary travel as a one-second speed burst.
    private static readonly DUNGEON_MAX_BUDGET_MS = 4000;
    private static readonly POSITION_TOLERANCE = 120;
    private static readonly MAX_SINGLE_PACKET_DISTANCE = 2600;
    private static readonly DUNGEON_MAX_SINGLE_PACKET_DISTANCE = 6000;
    // Authored same-level dungeon portals can cross nearly the entire map. Dread
    // Fable, for example, moves the player about 19,420 px between dream rooms
    // and about 14,465 px when the boss intro releases them. The old 12,000 px
    // cap rejected those legitimate transitions; after four rooms the violation
    // score reached 16 and the server destroyed the socket as if the player had
    // teleported. Keep this bounded, but large enough for the authored layouts.
    private static readonly TRANSFER_GRACE_MAX_DISTANCE = 25000;
    private static readonly CORRECTION_GRACE_MAX_DISTANCE = 400;
    private static readonly CORRECTION_GRACE_MS = 750;
    private static readonly MOBILITY_GRACE_MS = 1250;
    private static readonly MOBILITY_GRACE_DISTANCE = 1800;
    private static readonly QUARANTINE_SCORE = 8;
    private static readonly DISCONNECT_SCORE = 16;
    private static readonly QUARANTINE_MS = 5000;
    private static readonly MOBILITY_POWER_RANGES: ReadonlyArray<readonly [number, number]> = [
        [262, 283], [398, 419], [501, 511], [723, 737], [795, 805],
        [1164, 1184], [1187, 1207], [1209, 1219], [1323, 1333],
        [1394, 1405], [1487, 1509]
    ];

    static createState(reason: string = 'init'): MovementAuthorityState {
        return {
            lastAcceptedX: 0,
            lastAcceptedY: 0,
            lastAcceptedAtMs: 0,
            movementBudgetDistance: MovementAuthority.POSITION_TOLERANCE,
            movementBudgetUpdatedAtMs: 0,
            speedViolationScore: 0,
            lastMovementResetReason: reason,
            movementQuarantineUntilMs: 0,
            correctionGraceUntilMs: 0,
            mobilityGraceUntilMs: 0,
            mobilityRemainingDistance: 0,
            mobilityPowerId: 0
        };
    }

    private static xmlMobilityPowerIds: Set<number> | null = null;

    /**
     * Every dash in this game is authored as a pair: an "Open" power that starts the move
     * and a "Close" power that lands it, and the Close half is the one that carries the
     * player. The ranges above cover ShadowStep (1394-1405) but its Close variants are
     * 1406-1415; MistWalkClose10 is 1185 and AssassinateClose10 is 1208, both sitting in
     * gaps between ranges. So at high rank -- which is what a levelled character actually
     * casts -- the landing half of the dash got no mobility grace at all. The displacement
     * then scores as speed_delta or teleport_delta, eight points of that is a five second
     * movement quarantine, and sixteen destroys the socket.
     *
     * Hand-maintained id ranges cannot track a data file they are not read from, so the
     * power data is now consulted directly: anything it says displaces the caster counts.
     *
     * Union with the ranges, never a replacement. The ranges cover authored powers this
     * rule does not recognise, and the two failure directions are not symmetric -- an
     * unrecognised dash freezes and then disconnects an honest player, while an
     * over-granted one only widens a window the cheater still has to arm with a real cast
     * that CastRateAuthority has already metered.
     */
    private static loadXmlMobilityPowerIds(): Set<number> {
        if (MovementAuthority.xmlMobilityPowerIds) {
            return MovementAuthority.xmlMobilityPowerIds;
        }

        const powerIds = new Set<number>();
        MovementAuthority.xmlMobilityPowerIds = powerIds;

        const xmlDir = resolveClientXmlDir(['PlayerPowerTypes.xml']);
        if (!xmlDir) {
            console.warn('[MovementAuthority] PlayerPowerTypes.xml not found; mobility grace falls back to the authored id ranges.');
            return powerIds;
        }

        try {
            const xml = fs.readFileSync(path.join(xmlDir, 'PlayerPowerTypes.xml'), 'utf8');
            for (const block of xml.match(/<Power PowerName="[^"]*">[\s\S]*?<\/Power>/g) ?? []) {
                const powerId = Math.round(Number(block.match(/<PowerID>([^<]*)<\/PowerID>/)?.[1] ?? 0));
                if (!Number.isFinite(powerId) || powerId <= 0) {
                    continue;
                }

                const powerName = block.match(/<Power PowerName="([^"]*)">/)?.[1] ?? '';
                const castAnim = block.match(/<CastAnim>([^<]*)<\/CastAnim>/)?.[1] ?? '';
                const targetMethod = block.match(/<TargetMethod>([^<]*)<\/TargetMethod>/)?.[1] ?? '';
                // Charge closes distance to a target. `L:` prefixed anims and LungeStrike are
                // the authored lunges -- the ranges above already grant those, so keeping the
                // rule aligned with them stops the two sources disagreeing. Dash open/close
                // and the `*Close`/`*Close10` naming are the halves that were being missed.
                if (
                    targetMethod === 'Charge' ||
                    /dash|lunge/i.test(castAnim) ||
                    castAnim.startsWith('L:') ||
                    /Close\d*$/.test(powerName)
                ) {
                    powerIds.add(powerId);
                }
            }
            console.log(`[MovementAuthority] Loaded ${powerIds.size} mobility powers from the power data.`);
        } catch (err) {
            console.warn('[MovementAuthority] Could not read PlayerPowerTypes.xml; mobility grace falls back to the authored id ranges.', err);
        }

        return powerIds;
    }

    static isMobilityPower(powerId: number): boolean {
        const normalized = Math.max(0, Math.round(Number(powerId ?? 0)));
        if (MovementAuthority.MOBILITY_POWER_RANGES.some(([min, max]) => normalized >= min && normalized <= max)) {
            return true;
        }

        return MovementAuthority.loadXmlMobilityPowerIds().has(normalized);
    }

    static nowMs(): number {
        return Math.round(performance.timeOrigin + performance.now());
    }

    static noteMobilityCast(client: Pick<MovementAuthorityClient, 'movementAuthority'>, powerId: number, nowMs: number = MovementAuthority.nowMs()): boolean {
        if (!MovementAuthority.isMobilityPower(powerId)) {
            return false;
        }
        const state = client.movementAuthority ?? MovementAuthority.createState('mobility_cast');
        state.mobilityGraceUntilMs = Math.max(state.mobilityGraceUntilMs, nowMs + MovementAuthority.MOBILITY_GRACE_MS);
        state.mobilityRemainingDistance = Math.max(state.mobilityRemainingDistance, MovementAuthority.MOBILITY_GRACE_DISTANCE);
        state.mobilityPowerId = Math.max(0, Math.round(Number(powerId)));
        client.movementAuthority = state;
        return true;
    }

    static reset(client: Pick<MovementAuthorityClient, 'movementAuthority'>, reason: string, x: unknown = null, y: unknown = null, nowMs: number = MovementAuthority.nowMs()): void {
        const state = client.movementAuthority ?? MovementAuthority.createState(reason);
        state.lastAcceptedX = MovementAuthority.coordinate(x ?? state.lastAcceptedX);
        state.lastAcceptedY = MovementAuthority.coordinate(y ?? state.lastAcceptedY);
        state.lastAcceptedAtMs = Math.max(0, Math.round(nowMs));
        const speed = MovementAuthority.getSpeedPerSecond(client as MovementAuthorityClient, state.lastAcceptedAtMs);
        state.movementBudgetDistance = speed > 0 ? MovementAuthority.POSITION_TOLERANCE : 0;
        state.movementBudgetUpdatedAtMs = state.lastAcceptedAtMs;
        state.speedViolationScore = 0;
        state.lastMovementResetReason = reason;
        state.movementQuarantineUntilMs = 0;
        state.correctionGraceUntilMs = 0;
        state.mobilityGraceUntilMs = 0;
        state.mobilityRemainingDistance = 0;
        state.mobilityPowerId = 0;
        client.movementAuthority = state;
    }

    static resetFromEntity(client: Pick<MovementAuthorityClient, 'movementAuthority'>, entity: any, reason: string, nowMs: number = MovementAuthority.nowMs()): void {
        MovementAuthority.reset(client, reason, entity?.x, entity?.y, nowMs);
    }

    static armCorrectionGrace(client: Pick<MovementAuthorityClient, 'movementAuthority'>, nowMs: number = MovementAuthority.nowMs()): void {
        const state = client.movementAuthority ?? MovementAuthority.createState('server_position_correction');
        state.correctionGraceUntilMs = Math.max(state.correctionGraceUntilMs, nowMs + MovementAuthority.CORRECTION_GRACE_MS);
        client.movementAuthority = state;
    }

    static armRoomTransitionGrace(
        client: Pick<MovementAuthorityClient, 'movementAuthority' | 'roomTransitionGraceUntil'>,
        durationMs: number = 4000,
        nowMs: number = MovementAuthority.nowMs()
    ): void {
        client.roomTransitionGraceUntil = Math.max(
            Number(client.roomTransitionGraceUntil ?? 0),
            nowMs + Math.max(0, Math.round(Number(durationMs) || 0))
        );
    }

    static validateIncrementalMovement(
        client: MovementAuthorityClient,
        entity: any,
        deltaX: number,
        deltaY: number,
        nowMs: number = MovementAuthority.nowMs(),
        extraPacketValues: unknown[] = []
    ): MovementValidationResult {
        const state = client.movementAuthority ?? MovementAuthority.createState();
        client.movementAuthority = state;
        const normalizedNowMs = Math.max(0, Math.round(Number(nowMs) || 0));
        const currentX = MovementAuthority.coordinateOrNull(entity?.x);
        const currentY = MovementAuthority.coordinateOrNull(entity?.y);
        const movementDeltaX = MovementAuthority.coordinateOrNull(deltaX);
        const movementDeltaY = MovementAuthority.coordinateOrNull(deltaY);
        const elapsedMs = state.lastAcceptedAtMs > 0 ? Math.max(0, Math.round(normalizedNowMs - state.lastAcceptedAtMs)) : 0;
        const hasInvalidExtra = extraPacketValues.some((value) => MovementAuthority.coordinateOrNull(value) === null);
        if (currentX === null || currentY === null || movementDeltaX === null || movementDeltaY === null || hasInvalidExtra || !Number.isFinite(Number(nowMs))) {
            const fallbackX = Number.isFinite(Number(state.lastAcceptedX)) ? state.lastAcceptedX : 0;
            const fallbackY = Number.isFinite(Number(state.lastAcceptedY)) ? state.lastAcceptedY : 0;
            return MovementAuthority.reject(
                client,
                state,
                'invalid_delta',
                fallbackX,
                fallbackY,
                elapsedMs,
                0,
                Number.POSITIVE_INFINITY,
                normalizedNowMs
            );
        }

        if (
            normalizedNowMs + 1 < Math.max(0, Math.round(Number(state.lastAcceptedAtMs ?? 0))) ||
            normalizedNowMs + 1 < Math.max(0, Math.round(Number(state.movementBudgetUpdatedAtMs ?? 0)))
        ) {
            return MovementAuthority.reject(
                client,
                state,
                'reordered_movement_time',
                currentX,
                currentY,
                0,
                0,
                0,
                normalizedNowMs
            );
        }

        if (state.lastAcceptedAtMs <= 0) {
            state.lastAcceptedX = currentX;
            state.lastAcceptedY = currentY;
            state.lastAcceptedAtMs = normalizedNowMs;
            state.movementBudgetUpdatedAtMs = state.lastAcceptedAtMs;
            const initialSpeed = MovementAuthority.getSpeedPerSecond(client, normalizedNowMs);
            state.movementBudgetDistance = initialSpeed > 0 ? MovementAuthority.POSITION_TOLERANCE : 0;
        }

        const attemptedX = currentX + movementDeltaX;
        const attemptedY = currentY + movementDeltaY;
        const actualDistance = Math.hypot(attemptedX - state.lastAcceptedX, attemptedY - state.lastAcceptedY);

        const normalAllowed = MovementAuthority.refreshBudget(client, state, normalizedNowMs);
        if (normalizedNowMs < state.movementQuarantineUntilMs) {
            return { ...MovementAuthority.result(false, 'movement_quarantined', attemptedX, attemptedY, state, elapsedMs, 0, actualDistance), quarantine: true };
        }
        if (normalizedNowMs < state.correctionGraceUntilMs && actualDistance <= MovementAuthority.CORRECTION_GRACE_MAX_DISTANCE) {
            state.movementBudgetDistance = Math.max(0, state.movementBudgetDistance - actualDistance);
            MovementAuthority.accept(state, attemptedX, attemptedY, normalizedNowMs, 'server_correction_grace');
            return MovementAuthority.result(true, 'server_correction_grace', attemptedX, attemptedY, state, elapsedMs, MovementAuthority.CORRECTION_GRACE_MAX_DISTANCE, actualDistance);
        }
        if (MovementAuthority.hasTransitionGrace(client, normalizedNowMs) && actualDistance <= MovementAuthority.TRANSFER_GRACE_MAX_DISTANCE) {
            state.movementBudgetDistance = 0;
            MovementAuthority.accept(state, attemptedX, attemptedY, normalizedNowMs, 'transition_grace');
            return MovementAuthority.result(true, 'transition_grace', attemptedX, attemptedY, state, elapsedMs, MovementAuthority.TRANSFER_GRACE_MAX_DISTANCE, actualDistance);
        }

        const maxSinglePacketDistance = LevelConfig.isDungeonLevel(client.currentLevel)
            ? MovementAuthority.DUNGEON_MAX_SINGLE_PACKET_DISTANCE
            : MovementAuthority.MAX_SINGLE_PACKET_DISTANCE;
        if (actualDistance > maxSinglePacketDistance) {
            return MovementAuthority.reject(client, state, 'teleport_delta', attemptedX, attemptedY, elapsedMs, normalAllowed, actualDistance, normalizedNowMs);
        }
        if (normalizedNowMs < state.mobilityGraceUntilMs && state.mobilityRemainingDistance > 0) {
            const mobilityAllowed = Math.min(MovementAuthority.MAX_SINGLE_PACKET_DISTANCE, normalAllowed + state.mobilityRemainingDistance);
            if (actualDistance <= mobilityAllowed) {
                state.mobilityRemainingDistance = Math.max(0, state.mobilityRemainingDistance - Math.max(0, actualDistance - normalAllowed));
                state.movementBudgetDistance = Math.max(0, state.movementBudgetDistance - Math.min(actualDistance, normalAllowed));
                MovementAuthority.accept(state, attemptedX, attemptedY, normalizedNowMs, `mobility_power_${state.mobilityPowerId}`);
                return MovementAuthority.result(true, 'mobility_grace', attemptedX, attemptedY, state, elapsedMs, mobilityAllowed, actualDistance);
            }
        }
        if (actualDistance > normalAllowed) {
            return MovementAuthority.reject(client, state, 'speed_delta', attemptedX, attemptedY, elapsedMs, normalAllowed, actualDistance, normalizedNowMs);
        }
        state.movementBudgetDistance = Math.max(0, state.movementBudgetDistance - actualDistance);
        MovementAuthority.accept(state, attemptedX, attemptedY, normalizedNowMs, 'accepted');
        return MovementAuthority.result(true, 'accepted', attemptedX, attemptedY, state, elapsedMs, normalAllowed, actualDistance);
    }

    static commitCappedRejectedMovement(
        client: Pick<MovementAuthorityClient, 'movementAuthority'>,
        result: MovementValidationResult,
        nowMs: number = MovementAuthority.nowMs()
    ): MovementClampResult {
        const state = client.movementAuthority ?? MovementAuthority.createState('speed_delta_clamp');
        client.movementAuthority = state;
        if (
            result.accepted ||
            result.reason !== 'speed_delta' ||
            result.quarantine ||
            result.disconnect ||
            !Number.isFinite(result.actualDistance) ||
            !Number.isFinite(result.allowedDistance) ||
            result.actualDistance <= 0 ||
            result.allowedDistance <= 0
        ) {
            return { clamped: false, x: state.lastAcceptedX, y: state.lastAcceptedY };
        }

        const ratio = Math.max(0, Math.min(1, result.allowedDistance / result.actualDistance));
        if (ratio <= 0 || ratio >= 1) {
            return { clamped: false, x: state.lastAcceptedX, y: state.lastAcceptedY };
        }

        const clampedX = MovementAuthority.coordinate(
            result.lastAcceptedX + ((result.attemptedX - result.lastAcceptedX) * ratio)
        );
        const clampedY = MovementAuthority.coordinate(
            result.lastAcceptedY + ((result.attemptedY - result.lastAcceptedY) * ratio)
        );
        state.lastAcceptedX = clampedX;
        state.lastAcceptedY = clampedY;
        state.lastAcceptedAtMs = Math.max(0, Math.round(nowMs));
        state.movementBudgetUpdatedAtMs = state.lastAcceptedAtMs;
        state.movementBudgetDistance = 0;
        state.lastMovementResetReason = 'speed_delta_clamped';
        return { clamped: true, x: clampedX, y: clampedY };
    }

    private static getSpeedPerSecond(client: MovementAuthorityClient, nowMs: number = MovementAuthority.nowMs()): number {
        if (nowMs < Math.max(0, Math.round(Number(client.movementRootUntilMs ?? 0)))) {
            return 0;
        }
        const mounted = Number(client.character?.equippedMount ?? 0) > 0;
        const rawMultiplier = Number(client.movementSpeedMultiplier ?? 1);
        const speedMultiplier = Number.isFinite(rawMultiplier)
            ? Math.max(0, Math.min(3, rawMultiplier))
            : 1;
        return MovementAuthority.BASE_PLAYER_SPEED_PER_SECOND *
            (mounted ? MovementAuthority.MOUNT_SPEED_MULTIPLIER : 1) *
            speedMultiplier;
    }

    private static getMaxBudgetDistance(speed: number, maxBudgetMs: number = MovementAuthority.MAX_BUDGET_MS): number {
        if (speed <= 0) {
            return 0;
        }
        return Math.round(speed * maxBudgetMs / 1000 + MovementAuthority.POSITION_TOLERANCE);
    }

    private static refreshBudget(client: MovementAuthorityClient, state: MovementAuthorityState, nowMs: number): number {
        const speed = MovementAuthority.getSpeedPerSecond(client, nowMs);
        const maxBudgetMs = LevelConfig.isDungeonLevel(client.currentLevel)
            ? MovementAuthority.DUNGEON_MAX_BUDGET_MS
            : MovementAuthority.MAX_BUDGET_MS;
        const maxBudget = MovementAuthority.getMaxBudgetDistance(speed, maxBudgetMs);
        const updatedAt = Math.max(0, Math.round(Number(state.movementBudgetUpdatedAtMs ?? 0)));
        const elapsedMs = updatedAt > 0
            ? Math.max(0, Math.min(maxBudgetMs, Math.round(nowMs - updatedAt)))
            : 0;
        const earnedDistance = speed * elapsedMs / 1000;
        const previousBudget = Number.isFinite(Number(state.movementBudgetDistance))
            ? Math.max(0, Number(state.movementBudgetDistance))
            : 0;
        state.movementBudgetDistance = Math.min(maxBudget, previousBudget + earnedDistance);
        state.movementBudgetUpdatedAtMs = Math.max(0, Math.round(nowMs));
        return Math.round(state.movementBudgetDistance);
    }

    // A door reposition inside a level moves the player thousands of units in one packet, so
    // room changes need the same allowance level transfers get. This used to ride on
    // mountTransferGraceUntil, which armMountTravelProtection only sets for players with a
    // mount equipped -- on-foot players had their room transition scored as a teleport.
    private static hasTransitionGrace(client: MovementAuthorityClient, nowMs: number): boolean {
        return nowMs < Number(client.pendingTransferUntil ?? 0) ||
            nowMs < Number(client.mountTransferGraceUntil ?? 0) ||
            nowMs < Number(client.roomTransitionGraceUntil ?? 0) ||
            Boolean(String(client.activeDungeonCutsceneScope ?? '').trim()) ||
            LevelConfig.normalizeLevelName(client.currentLevel) === 'TutorialBoat';
    }

    private static accept(state: MovementAuthorityState, x: number, y: number, nowMs: number, reason: string): void {
        state.lastAcceptedX = MovementAuthority.coordinate(x);
        state.lastAcceptedY = MovementAuthority.coordinate(y);
        state.lastAcceptedAtMs = Math.max(0, Math.round(nowMs));
        if (Math.max(0, Math.round(Number(state.movementBudgetUpdatedAtMs ?? 0))) <= 0) {
            state.movementBudgetUpdatedAtMs = state.lastAcceptedAtMs;
        }
        state.speedViolationScore = Math.max(0, state.speedViolationScore - 1);
        state.lastMovementResetReason = reason;
    }

    private static reject(client: MovementAuthorityClient, state: MovementAuthorityState, reason: string, attemptedX: number, attemptedY: number, elapsedMs: number, allowedDistance: number, actualDistance: number, nowMs: number): MovementValidationResult {
        state.speedViolationScore += reason === 'teleport_delta' || reason === 'invalid_delta' ? 4 : 2;
        const quarantine = state.speedViolationScore >= MovementAuthority.QUARANTINE_SCORE;
        const disconnect = state.speedViolationScore >= MovementAuthority.DISCONNECT_SCORE;
        if (quarantine) state.movementQuarantineUntilMs = Math.max(state.movementQuarantineUntilMs, nowMs + MovementAuthority.QUARANTINE_MS);
        console.warn(`[MovementAuthority] rejected reason=${reason} userId=${client.userId ?? 0} character=${String(client.character?.name ?? 'unknown').replace(/\s+/g, '_')} level=${client.currentLevel || '(unknown)'} old=${state.lastAcceptedX},${state.lastAcceptedY} attempted=${attemptedX},${attemptedY} elapsedMs=${elapsedMs} allowed=${Math.round(allowedDistance)} actual=${Math.round(actualDistance)} score=${state.speedViolationScore}`);
        if (disconnect) client.socket?.destroy?.();
        return { ...MovementAuthority.result(false, reason, attemptedX, attemptedY, state, elapsedMs, allowedDistance, actualDistance), quarantine, disconnect };
    }

    private static result(accepted: boolean, reason: string, attemptedX: number, attemptedY: number, state: MovementAuthorityState, elapsedMs: number, allowedDistance: number, actualDistance: number): MovementValidationResult {
        return { accepted, reason, attemptedX, attemptedY, lastAcceptedX: state.lastAcceptedX, lastAcceptedY: state.lastAcceptedY, elapsedMs, allowedDistance, actualDistance, speedViolationScore: state.speedViolationScore, quarantine: false, disconnect: false };
    }

    private static coordinate(value: unknown): number {
        const numeric = Number(value ?? 0);
        return Number.isFinite(numeric) ? Math.round(numeric) : 0;
    }

    private static coordinateOrNull(value: unknown): number | null {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? Math.round(numeric) : null;
    }
}
