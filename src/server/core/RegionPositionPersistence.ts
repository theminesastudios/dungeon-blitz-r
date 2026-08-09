import { LevelConfig } from './LevelConfig';
import { resolveGroundedPosition } from './GroundedPosition';

/**
 * Where a character was standing when they last left a normal region, so logging back in puts
 * them there instead of at whatever CurrentLevel happened to hold.
 *
 * This module was reconstructed from src/server/dist/core/RegionPositionPersistence.js. The
 * TypeScript source had been lost, and because nothing in the source tree imported it, every
 * build from source shipped without it -- so positions were only ever written by the dungeon
 * return and transfer paths in Client.ts. Ordinary movement and ordinary disconnects wrote
 * nothing, which is why a reconnect dropped players at a stale coordinate and they fell.
 *
 * Two fields are kept deliberately:
 *   LastRegionPosition  the authoritative "somewhere safe in the open world" record
 *   CurrentLevel        what the spawn path already reads, kept in step with it
 *
 * Dungeons are excluded on purpose. Recording inside one would overwrite the town coordinate
 * a player has to come back to, so a disconnect in a dungeon returns them to where they
 * entered from rather than to a spot in an instance that no longer exists.
 */

export type RegionPositionReason = 'movement' | 'disconnect' | 'level_change' | 'periodic';

export interface RegionPosition {
    levelName: string;
    x: number;
    y: number;
    timestamp: number;
    characterId: number;
    userId: number;
}

interface RecordOptions {
    force?: boolean;
    persist?: boolean;
}

// Movement fires many times a second; this is the floor between saves it triggers.
const MOVEMENT_SAVE_INTERVAL_MS = 4_000;
// A month-old coordinate is more likely to be from a since-changed map than a useful spot.
const MAX_POSITION_AGE_MS = 1000 * 60 * 60 * 24 * 30;
// Guards against a corrupt or hostile coordinate being written back as a spawn point.
const MAX_ABSOLUTE_COORDINATE = 200_000;

function isNormalRegion(levelName: string): boolean {
    const normalized = LevelConfig.normalizeLevelName(levelName);
    return Boolean(normalized) && LevelConfig.has(normalized) && !LevelConfig.isDungeonLevel(normalized);
}

function isValidCoordinate(value: unknown): boolean {
    return Number.isFinite(Number(value)) && Math.abs(Number(value)) <= MAX_ABSOLUTE_COORDINATE;
}

function getCharacterKey(client: any): string {
    return String(client.character?.name ?? `user:${Number(client.userId ?? 0)}`).trim() || 'unknown';
}

export class RegionPositionPersistence {
    private static lastMovementSaveByCharacter = new Map<string, number>();

    static record(client: any, entity: any, reason: RegionPositionReason, options?: RecordOptions): boolean {
        const character = client?.character;
        const levelName = LevelConfig.normalizeLevelName(client?.currentLevel || character?.CurrentLevel?.name);
        // This record is replayed verbatim as a spawn point on the next login, so it may only
        // ever hold a point the player was standing on. Reading entity.x/y directly meant a
        // disconnect mid-jump, mid-fall or mid-knockback saved a spot in open air, and the
        // next login dropped the player out of the sky onto it -- or under the map, when the
        // sample came from a fall that had already passed the floor. An entity with no floor
        // sample yet falls back to the last saved coordinates rather than its live position.
        //
        // The level is passed so a sample taken on the map the player just left cannot be
        // filed under the one they are on now: the entity object outlives the level change --
        // `client.currentLevel` flips first -- and a save landing in that window is how a live
        // log ended up with `level=NewbieRoad x=360 y=1460`, which is CraftTown's spawn.
        //
        // This record is not what a spawn reads any more; LevelConfig.getConfirmedSpawnForLevel
        // is. It still decides *which level* a player belongs in on the next login, which is
        // why it is still written from whatever position is available.
        const grounded = entity ? resolveGroundedPosition(entity, levelName) : null;
        // The saved record is only a usable fallback while it belongs to the level being
        // recorded; borrowing another level's coordinates would file a point from the wrong map.
        const savedRecord = LevelConfig.normalizeLevelName(character?.CurrentLevel?.name) === levelName
            ? character?.CurrentLevel
            : null;
        const x = Number(grounded?.x ?? savedRecord?.x);
        const y = Number(grounded?.y ?? savedRecord?.y);
        if (!character || !isNormalRegion(levelName) || !isValidCoordinate(x) || !isValidCoordinate(y)) {
            return false;
        }

        const now = Date.now();
        const characterKey = getCharacterKey(client);
        const lastSaveAt = this.lastMovementSaveByCharacter.get(characterKey) ?? 0;
        if (reason === 'movement' && !options?.force && now - lastSaveAt < MOVEMENT_SAVE_INTERVAL_MS) {
            return false;
        }

        const position: RegionPosition = {
            levelName,
            x: Math.round(x),
            y: Math.round(y),
            timestamp: now,
            characterId: Number(character.id ?? character.characterId ?? 0) || 0,
            userId: Number(client.userId ?? character.userId ?? 0) || 0
        };

        character.LastRegionPosition = position;
        character.CurrentLevel = { name: position.levelName, x: position.x, y: position.y };
        this.lastMovementSaveByCharacter.set(characterKey, now);

        if (options?.persist !== false) {
            client.scheduleCharacterSave?.(`region position ${reason}`, reason === 'movement' ? 0 : undefined);
        }
        return true;
    }

    static forget(client: any): void {
        this.lastMovementSaveByCharacter.delete(getCharacterKey(client));
    }

    static restore(character: any): boolean {
        const position = character?.LastRegionPosition;
        const levelName = LevelConfig.normalizeLevelName(position?.levelName);
        const timestamp = Number(position?.timestamp ?? 0);
        if (
            !character ||
            !isNormalRegion(levelName) ||
            !isValidCoordinate(position?.x) ||
            !isValidCoordinate(position?.y) ||
            timestamp <= 0 ||
            Date.now() - timestamp > MAX_POSITION_AGE_MS
        ) {
            return false;
        }

        character.CurrentLevel = {
            name: levelName,
            x: Math.round(Number(position.x)),
            y: Math.round(Number(position.y))
        };
        console.log(
            `[PositionRestore] character=${String(character.name ?? 'unknown')} level=${levelName} ` +
            `x=${character.CurrentLevel.x} y=${character.CurrentLevel.y} reason=last_region_position`
        );
        return true;
    }
}
