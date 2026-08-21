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
    lastRoomTransitionAtMs: number;
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
    private static readonly POSITION_TOLERANCE = 120;
    private static readonly MAX_SINGLE_PACKET_DISTANCE = 2600;
    private static readonly TRANSFER_GRACE_MAX_DISTANCE = 12000;
    private static readonly CORRECTION_GRACE_MAX_DISTANCE = 400;
    private static readonly CORRECTION_GRACE_MS = 750;
    private static readonly MOBILITY_GRACE_MS = 1250;
    private static readonly MOBILITY_GRACE_DISTANCE = 1800;
    private static readonly QUARANTINE_SCORE = 8;
    private static readonly DISCONNECT_SCORE = 16;
    private static readonly QUARANTINE_MS = 5000;
    // A door between two rooms of the same dungeon repositions the player thousands of units in
    // a single packet, and it is the one teleport an honest player makes constantly. Live
    // JC_Mini2 (The East Wing) captures show the jump at ~1500-1700 units, landing both members
    // on the same authored y. The single-packet cap above still bounds what may be accepted
    // this way, and the cooldown keeps it to what a door can actually produce.
    private static readonly ROOM_TRANSITION_MIN_DISTANCE = 700;
    private static readonly ROOM_TRANSITION_COOLDOWN_MS = 1500;
    // Swapping rooms stalls the client while the new one is built, and that silence is what
    // separates a door from a dash: the two live JC_Mini2 transitions arrived 983ms and 1015ms
    // after the previous packet, while a player who is moving reports every few frames.
    private static readonly ROOM_TRANSITION_MIN_PACKET_GAP_MS = 400;
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
            mobilityPowerId: 0,
            lastRoomTransitionAtMs: 0
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

    static validateIncrementalMovement(
        client: MovementAuthorityClient,
        entity: any,
        deltaX: number,
        deltaY: number,
        nowMs: number = MovementAuthority.nowMs(),
        extraPacketValues: unknown[] = [],
        airborne: boolean = false
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

        if (actualDistance > MovementAuthority.MAX_SINGLE_PACKET_DISTANCE) {
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
        // Gravity is not a speed cheat.
        //
        // The budget above is a *running* budget, and the distance it is compared against is
        // the hypotenuse -- so a falling body is scored as though it had run the height of its
        // fall. The drop from a dungeon spawn point to the floor is around 1600px in a couple
        // of frames, which is far outside any run budget, so every entry fall was rejected and
        // the server's authoritative position stayed at the top of the drop. The player's own
        // client had long since landed, so nothing looked wrong to them -- but every other
        // screen was handed that stuck position and drew their body ~1600px above the room,
        // out of frame. That is the whole of "we are standing together and cannot see each
        // other": the bodies were being drawn, in the air, off camera.
        //
        // While the packet says airborne, judge only the horizontal component against the run
        // budget. Falling gains a cheater nothing -- the client's own collision decides where
        // the body lands -- and an actual teleport is still caught by the single-packet cap
        // above, which applies to the full distance.
        const horizontalDistance = Math.abs(attemptedX - state.lastAcceptedX);
        const speedDistance = airborne ? horizontalDistance : actualDistance;
        if (speedDistance > normalAllowed) {
            // Walking through a door inside a dungeon looks exactly like a speed cheat, and
            // rejecting it is what made party members invisible to each other for the rest of
            // a run.
            //
            // The grace that was supposed to cover this is armed by `cacheRoomId`, and only
            // when the room *id* changes -- but the client reports room 0 for the whole of a
            // dungeon (every `[Visibility]` line ever logged reads `room=0`), so the grace was
            // never armed and the transition was scored against the run budget. Two live
            // JC_Mini2 rejections tell the whole story: `old=15254,3198 attempted=15541,4719`
            // and `old=15680,3066 attempted=15397,4719` -- two different players landing on
            // the same authored floor of the next room, each refused.
            //
            // A refusal is not a rubber-band the mover can see: their own client has already
            // moved them and keeps sending small deltas from the new room, which the server
            // applies on top of the position it clamped them back to. So the server's copy of
            // that body stays a full room behind for the rest of the run, and that stale point
            // is what every other screen is handed -- the body is drawn, in a room nobody is
            // looking at. Both players do it, so neither can see the other, in every room.
            //
            // So a jump of door size is accepted as what it is. The single-packet cap above
            // still bounds it, the cooldown stops it becoming a general teleport, and the
            // caller uses the reason to re-seed the bodies on both sides of the door.
            if (MovementAuthority.isRoomTransitionJump(
                client,
                state,
                attemptedX,
                attemptedY,
                actualDistance,
                elapsedMs,
                normalizedNowMs
            )) {
                const fromX = Math.round(state.lastAcceptedX);
                const fromY = Math.round(state.lastAcceptedY);
                state.lastRoomTransitionAtMs = normalizedNowMs;
                state.movementBudgetDistance = 0;
                MovementAuthority.accept(state, attemptedX, attemptedY, normalizedNowMs, 'room_transition');
                console.log(
                    `[RoomTransition] ${String(client.character?.name ?? 'unknown').replace(/\s+/g, '_')} ` +
                    `level=${client.currentLevel || '(unknown)'} from=${fromX},${fromY} ` +
                    `to=${Math.round(attemptedX)},${Math.round(attemptedY)} distance=${Math.round(actualDistance)}`
                );
                return MovementAuthority.result(
                    true,
                    'room_transition',
                    attemptedX,
                    attemptedY,
                    state,
                    elapsedMs,
                    MovementAuthority.MAX_SINGLE_PACKET_DISTANCE,
                    actualDistance
                );
            }
            return MovementAuthority.reject(client, state, 'speed_delta', attemptedX, attemptedY, elapsedMs, normalAllowed, actualDistance, normalizedNowMs);
        }
        if (airborne) {
            state.movementBudgetDistance = Math.max(0, state.movementBudgetDistance - horizontalDistance);
            MovementAuthority.accept(state, attemptedX, attemptedY, normalizedNowMs, 'accepted_airborne');
            return MovementAuthority.result(true, 'accepted', attemptedX, attemptedY, state, elapsedMs, normalAllowed, actualDistance);
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

    private static getMaxBudgetDistance(speed: number): number {
        if (speed <= 0) {
            return 0;
        }
        return Math.round(speed * MovementAuthority.MAX_BUDGET_MS / 1000 + MovementAuthority.POSITION_TOLERANCE);
    }

    private static refreshBudget(client: MovementAuthorityClient, state: MovementAuthorityState, nowMs: number): number {
        const speed = MovementAuthority.getSpeedPerSecond(client, nowMs);
        const maxBudget = MovementAuthority.getMaxBudgetDistance(speed);
        const updatedAt = Math.max(0, Math.round(Number(state.movementBudgetUpdatedAtMs ?? 0)));
        const elapsedMs = updatedAt > 0
            ? Math.max(0, Math.min(MovementAuthority.MAX_BUDGET_MS, Math.round(nowMs - updatedAt)))
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

    /**
     * Is this jump the shape of a door inside a dungeon?
     *
     * Deliberately geometric rather than keyed on anything the client declares. The room id
     * cannot be used -- it reads 0 for a whole dungeon -- and the room packets arrive far too
     * often (a played sound is one) to be treated as a transition signal without disabling the
     * speed check outright.
     *
     * Five bounds keep this from becoming a free teleport: the level must be a dungeon, the
     * distance must be door-sized and still inside the single-packet cap that every path
     * obeys, the packet must arrive after a gap no moving player produces -- the client is
     * busy building the new room -- only one may be taken per cooldown, and the jump has to
     * actually *leave the room it started in*, measured against the level's own authored room
     * layout. A sprint across one long room, however large, is still `speed_delta`; so is a
     * dash in mid flight, which reports continuously and fails the gap test.
     */
    private static isRoomTransitionJump(
        client: MovementAuthorityClient,
        state: MovementAuthorityState,
        attemptedX: number,
        attemptedY: number,
        actualDistance: number,
        elapsedMs: number,
        nowMs: number
    ): boolean {
        if (!LevelConfig.isDungeonLevel(client.currentLevel)) {
            return false;
        }
        if (
            actualDistance < MovementAuthority.ROOM_TRANSITION_MIN_DISTANCE ||
            actualDistance > MovementAuthority.MAX_SINGLE_PACKET_DISTANCE
        ) {
            return false;
        }
        if (elapsedMs < MovementAuthority.ROOM_TRANSITION_MIN_PACKET_GAP_MS) {
            return false;
        }
        if (!MovementAuthority.leavesAuthoredRoom(
            client.currentLevel,
            state.lastAcceptedX,
            state.lastAcceptedY,
            attemptedX,
            attemptedY
        )) {
            return false;
        }

        const lastAtMs = Math.max(0, Math.round(Number(state.lastRoomTransitionAtMs ?? 0)));
        return lastAtMs <= 0 || nowMs - lastAtMs >= MovementAuthority.ROOM_TRANSITION_COOLDOWN_MS;
    }

    /**
     * The authored rooms of a dungeon, as bands of world space.
     *
     * Built from the same spawn registry the server seeds the level's enemies from, which is
     * the only data the server holds that says which room a coordinate belongs to -- the
     * client's own room id is useless here, it reads 0 for a whole run. A level with no
     * registry has no rooms as far as this is concerned, and nothing below it can fire: that
     * is deliberate, an unknown layout must not be able to authorise a teleport.
     */
    private static roomBandsByLevel = new Map<string, ReadonlyArray<{
        roomId: number;
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
        anchors: ReadonlyArray<{ x: number; y: number }>;
    }>>();

    private static getRoomBands(levelName: string | null | undefined) {
        const normalized = LevelConfig.normalizeLevelName(levelName) || String(levelName ?? '');
        const cached = MovementAuthority.roomBandsByLevel.get(normalized);
        if (cached) {
            return cached;
        }

        const { DungeonSpawnLoader } = require('../data/DungeonSpawnLoader') as typeof import('../data/DungeonSpawnLoader');
        // A Hard dungeon is the same authored map with harder enemies, and only the base name
        // carries a spawn registry.
        const baseName = /hard$/i.test(normalized) ? normalized.replace(/hard$/i, '') : normalized;
        const anchors = [
            ...DungeonSpawnLoader.getNpcsForLevel(normalized),
            ...(baseName !== normalized ? DungeonSpawnLoader.getNpcsForLevel(baseName) : [])
        ];

        const byRoom = new Map<number, { roomId: number; minX: number; maxX: number; minY: number; maxY: number; anchors: { x: number; y: number }[] }>();
        for (const anchor of anchors) {
            const roomId = Math.round(Number(anchor?.roomId ?? -1));
            const x = Number(anchor?.x);
            const y = Number(anchor?.y);
            if (roomId < 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
                continue;
            }
            const band = byRoom.get(roomId) ?? { roomId, minX: x, maxX: x, minY: y, maxY: y, anchors: [] };
            band.minX = Math.min(band.minX, x);
            band.maxX = Math.max(band.maxX, x);
            band.minY = Math.min(band.minY, y);
            band.maxY = Math.max(band.maxY, y);
            band.anchors.push({ x, y });
            byRoom.set(roomId, band);
        }

        const bands = Array.from(byRoom.values());
        // An empty answer is never cached. It is indistinguishable from "asked before the spawn
        // registry finished loading", and caching that would silently disable every door in the
        // level for the lifetime of the process.
        if (bands.length > 0) {
            MovementAuthority.roomBandsByLevel.set(normalized, bands);
        }
        return bands;
    }

    /** The authored room whose nearest anchor is closest to this point, or null when unknown. */
    private static resolveAuthoredRoom(levelName: string | null | undefined, x: number, y: number) {
        let closest: ReturnType<typeof MovementAuthority.getRoomBands>[number] | null = null;
        let closestDistance = Number.POSITIVE_INFINITY;
        for (const band of MovementAuthority.getRoomBands(levelName)) {
            for (const anchor of band.anchors) {
                const distance = Math.hypot(anchor.x - x, anchor.y - y);
                if (distance < closestDistance) {
                    closestDistance = distance;
                    closest = band;
                }
            }
        }
        return closest;
    }

    /**
     * Did this jump end somewhere the room it started in does not reach?
     *
     * Two ways to be sure of that, because neither alone covers every door. The nearest
     * authored anchor naming a different room is the direct answer. The second is for a room
     * the registry does not populate -- a landing hall, a corridor -- where the nearest anchor
     * still belongs to the room just left: a destination outside that room's own vertical band
     * by more than a floor's worth is on another floor of the dungeon, and no door within one
     * room does that.
     */
    private static readonly ROOM_BAND_FLOOR_TOLERANCE = 400;

    private static leavesAuthoredRoom(
        levelName: string | null | undefined,
        fromX: number,
        fromY: number,
        toX: number,
        toY: number
    ): boolean {
        const fromRoom = MovementAuthority.resolveAuthoredRoom(levelName, fromX, fromY);
        if (!fromRoom) {
            return false;
        }

        const toRoom = MovementAuthority.resolveAuthoredRoom(levelName, toX, toY);
        if (toRoom && toRoom.roomId !== fromRoom.roomId) {
            return true;
        }

        return (
            toY < fromRoom.minY - MovementAuthority.ROOM_BAND_FLOOR_TOLERANCE ||
            toY > fromRoom.maxY + MovementAuthority.ROOM_BAND_FLOOR_TOLERANCE
        );
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
