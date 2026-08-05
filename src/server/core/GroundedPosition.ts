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
 *
 * A sample also carries the level it was taken in, and that is not decoration. A floor
 * point is only meaningful on the map it was measured on, and the entity object outlives
 * the level change -- `client.currentLevel` flips to the new map while the entity still
 * holds the old map's sample, so a save taken in that window files one level's coordinates
 * under another level's name. That is not hypothetical: a live log has
 *
 *   [PositionRestore] character=Zeus level=NewbieRoad x=360 y=1460
 *
 * and {360, 1460} is CraftTown's authored spawn, restored into NewbieRoad, where it is
 * nowhere near the floor. Every consumer that knows which level it is placing a body in
 * passes that level, and a sample from anywhere else is refused.
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

/** Levels compare case-insensitively and ignoring surrounding space, as they do everywhere else. */
function normalizeLevel(level: unknown): string {
    return String(level ?? '').trim().toLowerCase();
}

export function isEntityAirborne(entity: any): boolean {
    if (!entity || typeof entity !== 'object') {
        return false;
    }

    const flags = entity as AirborneFlags;
    return Boolean(flags.airborne || flags.bJumping || flags.bDropping || flags.jumping || flags.dropping);
}

/**
 * True when the entity carries a floor sample that was taken somewhere other than
 * `expectedLevel`. An untagged sample is not foreign -- it predates the tag and is treated
 * as belonging wherever it is read, which is how the sample behaved before.
 */
function isForeignSample(entity: any, expectedLevel?: string | null): boolean {
    if (!expectedLevel) {
        return false;
    }
    const sampleLevel = normalizeLevel(entity.groundedLevel);
    if (!sampleLevel) {
        return false;
    }
    return sampleLevel !== normalizeLevel(expectedLevel);
}

/**
 * The last position the entity was known to be standing on, or null when there is none.
 *
 * The stored sample always wins over the live position: the live one is only usable as a
 * fallback for an entity that has not moved since it arrived, and only while it is not
 * airborne.
 *
 * `expectedLevel` is the level the caller is about to place the body in. Passing it is what
 * stops another map's floor point being replayed here; a caller that genuinely does not know
 * the level omits it and gets the old behaviour.
 */
export function resolveGroundedPosition(entity: any, expectedLevel?: string | null): GroundedPoint | null {
    if (!entity || typeof entity !== 'object') {
        return null;
    }

    if (isForeignSample(entity, expectedLevel)) {
        // The live position is no better -- it is the same coordinate space as the sample --
        // so there is nothing to fall back to and the caller has to use an authored spawn.
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
 *
 * `level` is the map the coordinates were measured on. Omitting it leaves whatever tag the
 * sample already had, which would be a lie about a new coordinate, so the tag is cleared
 * instead: an untagged sample is treated as belonging wherever it is read, and that is the
 * behaviour these coordinates had before the tag existed.
 */
export function noteGroundedSample(
    entity: any,
    x: number,
    y: number,
    airborne: boolean,
    level?: string | null,
): void {
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
    if (level) {
        entity.groundedLevel = String(level);
    } else {
        delete entity.groundedLevel;
    }
}

/**
 * Carry a floor sample from the entity a packet replaces onto the object that replaces it.
 *
 * A self full update rebuilds the player's entity from scratch, so without this the sample
 * every other path depends on is silently discarded on arrival in a level and again on
 * every gear or state refresh.
 *
 * The level tag rides along, because a sample that arrives in the new object untagged would
 * be indistinguishable from one measured here.
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
        if (previous.groundedLevel) {
            target.groundedLevel = String(previous.groundedLevel);
        }
    }
}

/**
 * Drop a floor sample that was taken on a different map.
 *
 * Called when a body arrives somewhere: whatever it was standing on before is not floor
 * here, and keeping it would let the old map's coordinates be saved under this map's name.
 */
export function discardForeignGroundedSample(entity: any, currentLevel: string | null | undefined): boolean {
    if (!entity || typeof entity !== 'object' || !isForeignSample(entity, currentLevel)) {
        return false;
    }

    delete entity.groundedX;
    delete entity.groundedY;
    delete entity.groundedLevel;
    return true;
}
