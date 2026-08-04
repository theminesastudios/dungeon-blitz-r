/**
 * The one place that answers "where was this body last standing on solid floor?".
 *
 * The server has no collision. entity.x/y is a running sum of the movement deltas the
 * client sends, and the only hint that a point has floor under it is the flag set the
 * packet carried. Every path that has to put a player somewhere -- level entry, the
 * login restore, the transfer save, party anchor spawns -- has to read a grounded
 * point, never the live one, or the client is handed a spot in open air and drops the
 * player from it (or, when the sample came from a fall, a spot below the map).
 *
 * Two shapes of the same entity reach these helpers, because the two packets that
 * carry a player's position do not agree on field names:
 *   0x07 incremental update -> bJumping / bDropping / airborne
 *   full update             -> jumping  / dropping  (no airborne bit at all)
 * Both spellings are treated as authoritative here so a full update can never launder
 * an airborne position into a grounded one.
 */

export interface GroundedPoint {
    x: number;
    y: number;
}

interface AirborneFlags {
    airborne?: boolean;
    bJumping?: boolean;
    bDropping?: boolean;
    jumping?: boolean;
    dropping?: boolean;
}

export function isEntityAirborne(entity: any): boolean {
    if (!entity || typeof entity !== 'object') {
        return false;
    }

    const flags = entity as AirborneFlags;
    return Boolean(flags.airborne || flags.bJumping || flags.bDropping || flags.jumping || flags.dropping);
}

/**
 * The last position the entity was known to be standing on, or null when there is none.
 *
 * The stored sample always wins over the live position: the live one is only usable as a
 * fallback for an entity that has not moved since it arrived, and only while it is not
 * airborne.
 */
export function resolveGroundedPosition(entity: any): GroundedPoint | null {
    if (!entity || typeof entity !== 'object') {
        return null;
    }

    const groundedX = Number(entity.groundedX);
    const groundedY = Number(entity.groundedY);
    if (Number.isFinite(groundedX) && Number.isFinite(groundedY)) {
        return { x: Math.round(groundedX), y: Math.round(groundedY) };
    }

    if (isEntityAirborne(entity)) {
        return null;
    }

    const liveX = Number(entity.x);
    const liveY = Number(entity.y);
    if (!Number.isFinite(liveX) || !Number.isFinite(liveY)) {
        return null;
    }

    return { x: Math.round(liveX), y: Math.round(liveY) };
}

/**
 * Record x/y as the entity's floor sample when the packet says it is standing.
 *
 * An airborne packet leaves the previous sample alone -- that is the whole point of
 * keeping one -- and never clears it.
 */
export function noteGroundedSample(entity: any, x: number, y: number, airborne: boolean): void {
    if (!entity || typeof entity !== 'object' || airborne) {
        return;
    }

    const numericX = Number(x);
    const numericY = Number(y);
    if (!Number.isFinite(numericX) || !Number.isFinite(numericY)) {
        return;
    }

    entity.groundedX = numericX;
    entity.groundedY = numericY;
}

/**
 * Carry a floor sample from the entity a packet replaces onto the object that replaces it.
 *
 * A self full update rebuilds the player's entity from scratch, so without this the sample
 * every other path depends on is silently discarded on arrival in a level and again on
 * every gear or state refresh.
 */
export function inheritGroundedSample(target: any, previous: any): void {
    if (!target || typeof target !== 'object' || !previous || typeof previous !== 'object') {
        return;
    }

    const groundedX = Number(previous.groundedX);
    const groundedY = Number(previous.groundedY);
    if (Number.isFinite(groundedX) && Number.isFinite(groundedY)) {
        target.groundedX = groundedX;
        target.groundedY = groundedY;
    }
}
