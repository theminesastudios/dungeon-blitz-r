import { NpcLoader, NpcDef } from '../data/NpcLoader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { Client, clearClientSpawnFallbackTimer, createKeepTutorialState } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { DeadHostileTombstone, GlobalState } from '../core/GlobalState';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { Entity, EntityProps, EntityState, EntityTeam } from '../core/Entity';
import { LevelConfig } from '../core/LevelConfig';
import { GameData } from '../core/GameData';
import { PetHandler } from './PetHandler';
import { BuildingHandler } from './BuildingHandler';
import { MissionHandler } from './MissionHandler';
import { noteDungeonRunBossCutscene, noteDungeonRunEntitySeen } from '../core/DungeonRunStats';
import { areClientsInSameParty, getPartyIdForClient, isClientPartyLeader, sharesRoomIds } from '../core/PartySync';
import { areClientsInSameLevelScope, getClientLevelScope, getLevelScopeKey, getScopeLevelName } from '../core/LevelScope';
import { getPartyRuntimeLevelForClient, getScopeRuntimeLevel } from '../core/RuntimeLevel';
import { clearBossAuthority, noteBossEntity } from '../core/BossAuthority';
import { clearOpenBossScene, getOpenBossScene, isRoomBossEntity, markRoomBossEntity } from '../core/RoomBossState';
import { getBossIdentityKey, getBossIdentityKeys } from '../core/BossCopyCensus';
import { TutorialDungeonAuthorityEntity, TutorialDungeonMechanics } from '../core/TutorialDungeonMechanics';
import { MovementAuthority } from '../core/MovementAuthority';
import {
    discardForeignGroundedSample,
    inheritGroundedSample,
    isEntityAirborne,
    noteGroundedSample,
    resolveConfirmedGroundedPosition,
    resolveGroundedPosition
} from '../core/GroundedPosition';
import {
    buildHomeStatueEntity,
    HOME_STATUE_LEVEL,
    HOME_STATUE_SLOTS,
    isHomeStatueEntityId,
    readHomeStatues
} from '../core/HomeStatues';
import { getCraftTownHomeOwnerCharacter } from '../utils/HomeVisitGuard';
import { HomeStatueHandler } from './HomeStatueHandler';

export class EntityHandler {
    private static readonly CLIENT_SPAWN_LEVELS = new Set<string>([
        'CraftTownTutorial',
        'CraftTown',
        'NewbieRoad',
        'NewbieRoadHard',
        'GoblinRiverDungeon',
        'GoblinRiverDungeonHard',
        'SwampRoadNorth',
        'SwampRoadNorthHard',
        'SwampRoadConnection',
        'SwampRoadConnectionHard',
        'BridgeTown',
        'BridgeTownHard',
        'CemeteryHill',
        'CemeteryHillHard',
        'OldMineMountain',
        'OldMineMountainHard',
        'EmeraldGlades',
        'EmeraldGladesHard',
        'AC_Mission1',
        'AC_Mission1Hard',
        'Castle',
        'CastleHard',
        'ShazariDesert',
        'ShazariDesertHard',
        'JadeCity',
        'JadeCityHard'
    ]);
    private static readonly MOUNT_SYNC_RETRY_DELAYS_MS = [0, 300, 1200, 2500, 4000];
    private static readonly CLIENT_SPAWN_JOINER_SEED_DELAYS_MS = [2500, 4500];
    // Short, because an unseen party member is unplayable, and twice, because the two halves
    // of a door transfer can complete in either order.
    private static readonly PLAYER_VISIBILITY_RESYNC_DELAYS_MS = [1200, 3000];
    private static readonly GOBLIN_RIVER_ROOM_SYNC_SKIP_LEVELS = new Set<string>([
        'TutorialDungeon',
        'GoblinRiverDungeon',
        'GoblinRiverDungeonHard'
    ]);
    private static readonly SERVER_AUTHORITY_HOSTILE_LEVELS = new Set<string>([
        'JC_Mini1Hard',
        'JC_Mini2',
        // The Dread variant is the same authored dungeon; leaving it out meant a Dread East
        // Wing run fell back to client-owned hostiles and split the party's enemies again.
        'JC_Mini2Hard',
        'TutorialDungeon'
    ]);
    // Levels whose hostiles the server DRAWS, not just adjudicates. Every enemy arrives as a
    // real remote entity through 0x0F, which is the only way it gets a class_122 record
    // (`Entity.var_38`) -- and without one the client's 0x07 and 0x0D readers both return
    // early, so no server-decided health or death can ever reach it.
    //
    // This is one half of a pair. The other is the client cue suppression in LevelsJC.swf
    // (`src/server/scripts/patch-levelsjc-east-wing-suppress-client-cues.js`), which holds the
    // rooms' authored cues so the client draws none of them. Ship either half alone and the
    // dungeon is empty or every enemy is drawn twice -- `LinkUpdater.method_1828` only merges
    // duplicates that both carry the REMOTE flag, so a client-spawned copy is never deduped
    // against a server-sent one.
    //
    // The roster comes from data/dungeonSpawns/levelsJC_the_east_wing.enemies.json: 34
    // hostiles plus the room-3 boss. The boss is deliberately NOT drawn by the server -- room
    // 3 drives the whole encounter through its am_Boss cue -- so it stays client-spawned and
    // the suppression skips it too.
    // EMPTY ON PURPOSE. Server-drawn hostiles are off, and The East Wing is the reason.
    //
    // Drawing them here means suppressing the level's own cues, and the client's dungeon
    // progress cannot survive that: `Room.var_802` (the room's enemy total) is accumulated
    // only inside `Room.SpawnCue`, and `Room.method_1990` counts only the room's own
    // `var_229` list. Hold the cues and both stay empty, at which point
    // `Room.method_1264` hits `if (var_2261 && !var_802) return 0` and the room reads as
    // fully cleared. Server-sent entities go into `Game.entities`, never into the room's
    // bookkeeping, so they can never make up the difference -- which is a dungeon opening at
    // 50% and climbing in room-sized steps, with no server-side fix possible.
    //
    // Re-enabling this needs a client patch that registers server-sent hostiles into the
    // room (`var_229` / `var_802`). Until then the client spawns them and the server binds
    // to those copies, which is what everything else in this file already assumes.
    private static readonly FIRST_SIGHT_SERVER_AUTHORITY_HOSTILE_LEVELS = new Set<string>();
    private static readonly CANONICAL_VISIBLE_PROXY_MATCH_MAX_DISTANCE_SQ = 400 * 400;
    static readonly SERVER_AUTHORITY_ENTITY_LEVEL = 50;
    private static readonly HOSTILE_BASE_HITPOINTS = [
        100, 4920, 5580, 6020, 6520, 7040, 7580, 8180, 8800, 9480, 10180, 10960, 11740, 12640, 13540, 14540,
        15560, 16660, 17860, 19120, 20440, 21860, 23360, 24960, 26680, 28460, 30380, 32420, 34580, 36900, 39320,
        41920, 44660, 47560, 50660, 53940, 57420, 61080, 64980, 69120, 73520, 78160, 83100, 88300, 93820, 99700,
        105880, 112460, 119400, 126760, 134560
    ];
    private static serverAuthoritySeededScopes = new Set<string>();
    // Bounded redraw attempts per `viewerToken:canonicalId`, for levels the server draws.
    private static drawnHostileRetries = new Map<string, number>();
    private static readonly DRAWN_HOSTILE_RETRY_LIMIT = 4;
    private static serverAuthorityDestroyedIdsByScope = new Map<string, Set<number>>();
    private static serverAuthorityDestroyedFingerprintsByScope = new Map<string, Set<string>>();
    private static craftTownTutorialHelperIdsCache: Set<number> | null = null;

    private static normalizeIdentityName(value: unknown): string {
        return String(value ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '');
    }

    private static getCraftTownTutorialAuthoredHelperIds(): Set<number> {
        if (EntityHandler.craftTownTutorialHelperIdsCache) {
            return new Set(EntityHandler.craftTownTutorialHelperIdsCache);
        }

        const helperIds = new Set<number>(
            NpcLoader.getRawNpcsForLevel('CraftTownTutorial')
                .filter((npc) =>
                    String(npc?.name ?? '') === 'GoblinDagger' &&
                    String(npc?.DramaAnim ?? '') === 'Board' &&
                    Number(npc?.team ?? 0) === 2
                )
                .map((npc) => Number(npc.id ?? 0))
                .filter((id) => id > 0)
        );

        EntityHandler.craftTownTutorialHelperIdsCache = helperIds;
        return new Set(helperIds);
    }

    private static usesClientSpawn(levelName: string): boolean {
        return EntityHandler.CLIENT_SPAWN_LEVELS.has(levelName);
    }

    /**
     * Whether this canonical hostile is the room's completion boss, as the spawn registry
     * marks it. Bosses in a canonical-visible level must not be drawn by the server: their
     * room's cue owns the encounter script, so the client keeps spawning them.
     */
    static isCanonicalRoomBossEntity(entityProps: any): boolean {
        return Boolean(entityProps?.boss) ||
            Boolean(entityProps?.roomBoss) ||
            Boolean(entityProps?.isRoomBoss);
    }

    static usesServerAuthorityHostiles(levelName: string | null | undefined): boolean {
        return EntityHandler.SERVER_AUTHORITY_HOSTILE_LEVELS.has(LevelConfig.normalizeLevelName(levelName));
    }

    static usesCanonicalVisibleServerAuthorityHostiles(levelName: string | null | undefined): boolean {
        return EntityHandler.FIRST_SIGHT_SERVER_AUTHORITY_HOSTILE_LEVELS.has(
            LevelConfig.normalizeLevelName(getScopeLevelName(String(levelName ?? '')))
        );
    }

    private static getServerAuthorityDestroyedIds(levelScope: string): Set<number> {
        let destroyedIds = EntityHandler.serverAuthorityDestroyedIdsByScope.get(levelScope);
        if (!destroyedIds) {
            destroyedIds = new Set<number>();
            EntityHandler.serverAuthorityDestroyedIdsByScope.set(levelScope, destroyedIds);
        }

        return destroyedIds;
    }

    private static getServerAuthorityDestroyedFingerprints(levelScope: string): Set<string> {
        let destroyedFingerprints = EntityHandler.serverAuthorityDestroyedFingerprintsByScope.get(levelScope);
        if (!destroyedFingerprints) {
            destroyedFingerprints = new Set<string>();
            EntityHandler.serverAuthorityDestroyedFingerprintsByScope.set(levelScope, destroyedFingerprints);
        }

        return destroyedFingerprints;
    }

    private static getServerAuthorityHostileFingerprint(entity: any): string {
        if (!entity || entity.isPlayer || Number(entity.team ?? 0) !== EntityTeam.ENEMY) {
            return '';
        }

        const name = EntityHandler.normalizeServerAuthorityProxyName(
            entity.name ?? entity.EntName ?? entity.entName ?? entity.characterName ?? entity.character_name
        );
        if (!name) {
            return '';
        }

        const roomId = Number.isFinite(Number(entity.roomId)) ? Math.round(Number(entity.roomId)) : -1;
        const x = Number.isFinite(Number(entity.x)) ? Math.round(Number(entity.x) / 100) : 0;
        const y = Number.isFinite(Number(entity.y)) ? Math.round(Number(entity.y) / 100) : 0;
        return `${name}:${roomId}:${x}:${y}`;
    }

    static noteServerAuthorityHostileDestroyed(levelScope: string, entityId: number, entity: any = null, killerToken: number = 0): void {
        const scopeKey = String(levelScope ?? '').trim();
        const id = Math.max(0, Math.round(Number(entityId) || 0));
        if (!scopeKey || id <= 0 || !EntityHandler.usesServerAuthorityHostiles(getScopeLevelName(scopeKey))) {
            return;
        }

        EntityHandler.getServerAuthorityDestroyedIds(scopeKey).add(id);
        const fingerprint = EntityHandler.getServerAuthorityHostileFingerprint(entity);
        if (fingerprint) {
            EntityHandler.getServerAuthorityDestroyedFingerprints(scopeKey).add(fingerprint);
        }
        if (entity) {
            EntityHandler.upsertDeadServerAuthorityHostileTombstone(scopeKey, entity, 'note_destroyed', killerToken);
        }
    }

    static getDeadServerAuthorityHostileTombstones(levelScope: string): Map<string, DeadHostileTombstone> {
        const scopeKey = String(levelScope ?? '').trim();
        let tombstones = GlobalState.deadServerAuthorityHostilesByScope.get(scopeKey);
        if (!tombstones) {
            tombstones = new Map<string, DeadHostileTombstone>();
            GlobalState.deadServerAuthorityHostilesByScope.set(scopeKey, tombstones);
        }

        return tombstones;
    }

    static clearDeadServerAuthorityHostileTombstones(levelScope: string, reason: string): void {
        const scopeKey = String(levelScope ?? '').trim();
        if (!scopeKey) {
            return;
        }

        const count = GlobalState.deadServerAuthorityHostilesByScope.get(scopeKey)?.size ?? 0;
        GlobalState.deadServerAuthorityHostilesByScope.delete(scopeKey);
    }

    static upsertDeadServerAuthorityHostileTombstone(
        levelScope: string,
        entity: any,
        reason: string,
        killerToken: number = 0
    ): DeadHostileTombstone | null {
        const scopeKey = String(levelScope ?? '').trim();
        const canonicalId = Math.max(0, Math.round(Number(entity?.id ?? entity?.canonicalId ?? 0)));
        if (!scopeKey || canonicalId <= 0 || !EntityHandler.isServerAuthorityHostileEntity(scopeKey, entity)) {
            return null;
        }

        const spawnKey = String(entity.spawnKey || EntityHandler.getHostileSpawnKey(scopeKey, entity));
        entity.spawnKey = spawnKey;
        const tombstones = EntityHandler.getDeadServerAuthorityHostileTombstones(scopeKey);
        const existing = tombstones.get(spawnKey);
        const levelName = getScopeLevelName(scopeKey);
        const deathFinalizedAt = Math.max(0, Math.round(Number(entity.deathFinalizedAt ?? Date.now())));
        const tombstone: DeadHostileTombstone = {
            canonicalId,
            spawnKey,
            levelScope: scopeKey,
            levelName,
            roomId: Math.max(-1, Math.round(Number(entity.roomId ?? -1))),
            enemyType: String(entity.entType ?? entity.EntType ?? entity.name ?? entity.EntName ?? ''),
            name: String(entity.name ?? entity.EntName ?? entity.entName ?? ''),
            x: Math.round(Number(entity.x ?? entity.physPosX ?? 0) || 0),
            y: Math.round(Number(entity.y ?? entity.physPosY ?? 0) || 0),
            killedAt: Math.max(0, Math.round(Number(existing?.killedAt ?? deathFinalizedAt))),
            killerToken: Math.max(0, Math.round(Number(killerToken || existing?.killerToken || 0))),
            lootDropNonce: String(entity.lootDropNonce ?? existing?.lootDropNonce ?? ''),
            deathFinalizedAt,
            dead: true,
            destroyed: true,
            deathVersion: Math.max(1, Math.round(Number(entity.deathVersion ?? existing?.deathVersion ?? 1)))
        };
        tombstones.set(spawnKey, tombstone);
        EntityHandler.getServerAuthorityDestroyedIds(scopeKey).add(canonicalId);
        const fingerprint = EntityHandler.getServerAuthorityHostileFingerprint(entity);
        if (fingerprint) {
            EntityHandler.getServerAuthorityDestroyedFingerprints(scopeKey).add(fingerprint);
        }
        return tombstone;
    }

    static findDeadServerAuthorityHostileTombstone(levelScope: string, entity: any): DeadHostileTombstone | null {
        const scopeKey = String(levelScope ?? '').trim();
        if (!scopeKey || !entity) {
            return null;
        }

        const tombstones = GlobalState.deadServerAuthorityHostilesByScope.get(scopeKey);
        if (!tombstones || tombstones.size === 0) {
            return null;
        }

        const spawnKey = String(entity.spawnKey || EntityHandler.getHostileSpawnKey(scopeKey, entity));
        const exact = tombstones.get(spawnKey);
        if (exact) {
            return exact;
        }

        // An enemy the scope owns is identified, and its own id is the only thing that may
        // match it to a grave.
        //
        // The positional fallback below matches on `name:roomId:x/100:y/100` computed from
        // where the enemy is standing RIGHT NOW. The East Wing rooms hold several copies of the
        // same type -- four ShadeWarrior, three Ghoul, five PortalFiend -- and they walk. So
        // the moment a living one wandered into the 100px box where its same-named sibling had
        // died, it matched that sibling's tombstone, `isCanonicalHostileTerminal` called it
        // dead, and the proxy correction buried it. Live: ShadeWarrior 920011 was killed
        // properly (dealt=6076) and ShadeWarrior 920007 went down in the same breath with
        // `dealt=0` -- never hit, never fought, executed by a grave that was not its own.
        //
        // That is the reported "enemies execute themselves at half health without me landing
        // the last hit": the enemy in front of the player dies the instant another one of its
        // kind does.
        const canonicalId = Math.max(0, Math.round(Number(entity.id ?? 0)));
        if (canonicalId > 0) {
            for (const tombstone of tombstones.values()) {
                if (Math.max(0, Math.round(Number(tombstone.canonicalId ?? 0))) === canonicalId) {
                    return tombstone;
                }
            }
            // Known to the scope under this id, so the roster entry is the authority on whether
            // it is alive. Only a body the scope cannot identify is matched by where it stands.
            if (GlobalState.levelEntities.get(scopeKey)?.has(canonicalId)) {
                return null;
            }
        }

        const fingerprint = EntityHandler.getServerAuthorityHostileFingerprint(entity);
        if (!fingerprint) {
            return null;
        }

        for (const tombstone of tombstones.values()) {
            const tombstoneFingerprint = EntityHandler.getServerAuthorityHostileFingerprint({
                name: tombstone.name || tombstone.enemyType,
                team: EntityTeam.ENEMY,
                roomId: tombstone.roomId,
                x: tombstone.x,
                y: tombstone.y
            });
            if (tombstoneFingerprint === fingerprint) {
                return tombstone;
            }
        }

        return null;
    }

    private static getHostileBaseHpForLevel(level: number): number {
        const maxIndex = EntityHandler.HOSTILE_BASE_HITPOINTS.length - 1;
        const clampedLevel = Math.max(1, Math.min(maxIndex, Math.floor(Number(level) || 1)));
        return EntityHandler.HOSTILE_BASE_HITPOINTS[clampedLevel];
    }

    // The tier each run is being fought at, latched per scope. See
    // `resolveServerAuthorityEntityLevel`.
    private static readonly serverAuthorityScopeLevels = new Map<string, number>();

    /**
     * The highest player level in this scope, or 0 when the scope has nobody in it.
     *
     * Read from the live sessions rather than any index: this decides how hard the whole run
     * is, and a session missed here would size the dungeon for the wrong party.
     */
    private static resolvePartyEnemyLevelForScope(levelScope: string): number {
        if (!levelScope) {
            return 0;
        }

        // Most callers hand this a full scope key, but a good number pass the bare level name
        // -- and matching only on the full key made those silently miss every session and fall
        // back to the authored tier, which then re-sized hostiles that had been built correctly.
        // A bare name matches on the level instead, which is the same answer whenever a level
        // holds one run, and never sizes a run *down* when it holds more than one.
        const scopeLevelName = LevelConfig.normalizeLevelName(getScopeLevelName(levelScope));
        const matchWholeScope = levelScope !== scopeLevelName;

        let highest = 0;
        for (const session of GlobalState.sessionsByToken.values()) {
            if (!session.playerSpawned) {
                continue;
            }
            const matches = matchWholeScope
                ? getClientLevelScope(session) === levelScope
                : LevelConfig.normalizeLevelName(session.currentLevel) === scopeLevelName;
            if (!matches) {
                continue;
            }
            const characterLevel = Math.round(Number(session.character?.level ?? 0) || 0);
            if (characterLevel > highest) {
                highest = characterLevel;
            }
        }

        return highest;
    }

    /**
     * The tier a server-authority hostile is sized and stamped at.
     *
     * **The highest player level in the run**, and one number for the whole party. This is the
     * point: a level 22 and a level 50 fighting together must be looking at the same enemy with
     * the same health pool, or the enemy dies on one screen while the other still sees it on
     * full health. Sizing it per viewer is what produced that, and sizing it from the level's
     * own authored tier (what this did before) still leaves a level 50 walking through a tier
     * 29 dungeon unopposed.
     *
     * **Latched per scope, and it only ever rises.** Recomputing it freely would resize every
     * enemy the moment somebody loads, unloads or dies -- health pools moving under a fight in
     * progress. Rising is safe because `normalizeServerAuthorityHostileState` preserves the
     * damage already dealt, so a bigger pool means the enemy has proportionally more left, not
     * that it comes back to life.
     *
     * The authored dungeon tier, and then the old flat constant, remain the fallback for a
     * scope with nobody in it -- an entity looked up by name alone, or mid-transfer state --
     * where sizing a hostile down would be worse than leaving it where it was.
     */
    /**
     * 'party' scales client-owned hostiles to the highest player level in the run;
     * 'authored' keeps them at the dungeon's own tier, the number the client uses.
     * See the note inside resolveServerAuthorityEntityLevel for what each one costs.
     */
    static readonly CLIENT_OWNED_HOSTILE_TIER: 'party' | 'authored' = 'authored';
    /**
     * Tell the client which tier to spawn this run's hostiles at.
     *
     * The client already has the knob and already uses it. Every hostile it spawns is sized
     * as `const_867[Game.mBonusLevels + level.mapLevel] * entType.HitPoints`, and packet 0x5E
     * -- `LinkUpdater.method_1061`, three operations long -- reads one integer straight into
     * `Game.mBonusLevels` and does nothing else. The server has never sent it.
     *
     * So the run's difficulty is one number away: send the DIFFERENCE between the tier this
     * run is fought at and the level's own authored tier, and the client sizes the bodies it
     * spawns to match what the server is holding. That is what makes party scaling
     * enforceable at all -- without it the server's pool is a number the client never sees,
     * and every health correction turns into a second helping of damage.
     *
     * Two properties of `mBonusLevels` shape how this is used:
     *   - it is an OFFSET on `mapLevel`, not an absolute level;
     *   - it only affects bodies spawned after it arrives, so it has to be sent before the
     *     client plays the room's cues -- level entry, and again for anyone who joins.
     *
     * Sent for every level, zero included: leaving a dungeon has to clear the offset, or the
     * next map inherits it.
     */
    static readonly DUNGEON_BONUS_LEVELS_PACKET = 0x5E;

    /**
     * Count a player towards their run's tier before the scope has caught up with them.
     *
     * `resolvePartyEnemyLevelForScope` reads live sessions, which is right everywhere else and
     * useless during a login: the client is not spawned yet, so it sees nobody. Seeding the
     * latch from the arriving character closes that window, and because the latch is what the
     * run is locked to, the tier a member is TOLD is always the tier the run is fought at.
     */
    static noteRunTierFromClient(levelScope: string, client: Client): void {
        const scopeKey = String(levelScope ?? '').trim();
        const characterLevel = Math.max(0, Math.round(Number(client.character?.level ?? 0)));
        if (!scopeKey || characterLevel <= 0) {
            return;
        }

        const clamped = Math.max(1, Math.min(EntityHandler.HOSTILE_BASE_HITPOINTS.length - 1, characterLevel));
        const latched = EntityHandler.serverAuthorityScopeLevels.get(scopeKey) ?? 0;
        if (clamped > latched) {
            EntityHandler.serverAuthorityScopeLevels.set(scopeKey, clamped);
        }
    }
    static sendDungeonBonusLevels(client: Client, levelName: string | null | undefined): void {
        const normalized = LevelConfig.normalizeLevelName(levelName) || '';
        const authoredLevel = LevelConfig.getAuthoredDungeonEnemyLevel(normalized);
        let bonus = 0;
        if (authoredLevel > 0 && EntityHandler.usesServerAuthorityHostiles(normalized)) {
            const scope = getLevelScopeKey(normalized, client.levelInstanceId);

            // The entering player's own level counts, and it has to count HERE.
            //
            // The tier normally comes from the sessions already standing in the scope, and at
            // this moment there are none: this client is still logging in and is not spawned or
            // indexed yet. So the first member into a dungeon resolved a tier of zero, fell back
            // to the authored one, and was sent an offset of nothing -- their client then built
            // the whole room at the authored tier while the server, once they finally counted,
            // locked the run at 50 and sized every canonical to match.
            //
            // That is one player fighting 7380-point bodies against 26912-point canonicals for
            // the rest of the run: they kill what is on their screen, the server keeps the enemy
            // alive with the difference, and everyone else sees it standing. It was the first
            // member every time, which is exactly who clears the dungeon.
            EntityHandler.noteRunTierFromClient(scope, client);

            // Held at zero, deliberately, and the packet still sent.
            //
            // `mBonusLevels` only reaches the client's OTHER level branch; a hostile spawned
            // from a level cue reads `entType.baseLevel` and never sees it. Sending a real
            // offset therefore does nothing for the bodies this dungeon is made of, while
            // quietly enlarging any entity that does use the branch -- a fresh mismatch of
            // exactly the kind the server now goes out of its way to avoid, since it sizes
            // canonicals from the same `entType` level the client uses.
            //
            // The packet is still worth sending at zero: it clears an offset left over from
            // wherever the player was before.
            bonus = 0;
        }

        const bb = new BitBuffer(false);
        bb.writeMethod4(bonus);
        client.sendBitBuffer(EntityHandler.DUNGEON_BONUS_LEVELS_PACKET, bb);
        // Logged for every dungeon entry, zero included. A missing line used to be
        // indistinguishable from an offset of nothing, and an offset of nothing was the bug:
        // one member silently building the room at the authored tier while the run was fought
        // at another.
        if (authoredLevel > 0) {
            console.log(
                `[DungeonBonusLevels] ${normalized} -> ${String(client.character?.name ?? '?')} ` +
                `+${bonus} (authored ${authoredLevel})`
            );
        }
    }
    static resolveServerAuthorityEntityLevel(levelNameOrScope: string | null | undefined): number {
        const scopeKey = String(levelNameOrScope ?? '');
        const levelName = getScopeLevelName(scopeKey);
        const authoredLevel = LevelConfig.getAuthoredDungeonEnemyLevel(levelName);
        const fallback = authoredLevel > 0 ? authoredLevel : EntityHandler.SERVER_AUTHORITY_ENTITY_LEVEL;
        if (!scopeKey) {
            return fallback;
        }

        // Which tier a client-owned hostile is sized at. One switch, because the two answers
        // are a real trade and the right one is decided by playing, not by reading.
        //
        // AUTHORED: the number the client itself uses. Both sides then agree on the pool, and
        // an enemy dies on the server at the same moment it dies on the screen.
        //
        // PARTY: the highest player level in the run, which is what makes a level 50 party
        // fight level 50 enemies. The server cannot push that pool into the client -- these
        // bodies are spawned and sized by the client from the authored tier -- so the two
        // disagree by the ratio between the tiers (3.65x in The East Wing: 26912 against 7380).
        // 'party' was tried on 2026-08-18 and reverted the same day, and the reason is worth
        // keeping: it is not cosmetic. Every health correction is a subtraction between two
        // numbers in the CANONICAL's scale, and the client applies the result to a body in its
        // own. Hit an enemy for 5900 and the attacker's client takes it down locally, 7380 to
        // 1480; the canonical goes 26912 to 21012; the correction that follows is
        // 21012 - 26912 = -5900, and that lands on the copy a second time -- on 1480 of health.
        // So one or two hits execute anything, with the health bar barely moving. That is the
        // reported "they die without the bar going down".
        //
        // Making 'party' work needs every HP packet to be expressed in the client's scale
        // (multiplied by clientPool / canonicalPool) at each of the ~15 sites that send one.
        // Until then the two sides have to share a number, and 'authored' is the one they both
        // already use.
        if (
            EntityHandler.CLIENT_OWNED_HOSTILE_TIER === 'authored' &&
            authoredLevel > 0 &&
            !EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelName)
        ) {
            return Math.max(1, Math.min(EntityHandler.HOSTILE_BASE_HITPOINTS.length - 1, authoredLevel));
        }

        const partyLevel = EntityHandler.resolvePartyEnemyLevelForScope(scopeKey);
        const latched = EntityHandler.serverAuthorityScopeLevels.get(scopeKey) ?? 0;
        const resolved = Math.max(latched, partyLevel);
        if (resolved <= 0) {
            return fallback;
        }

        // Locked once the run has a tier, and deliberately not raised afterwards.
        //
        // The tier reaches the client as `Game.mBonusLevels`, and that only sizes bodies the
        // client spawns AFTER it arrives. Raising the run mid-way would grow the server's pools
        // while every enemy already standing on every screen kept the old one -- the exact
        // disagreement this whole mechanism exists to remove, reintroduced halfway through a
        // fight. A higher-level member joining gets the run as it was when it started.
        const clamped = Math.max(1, Math.min(EntityHandler.HOSTILE_BASE_HITPOINTS.length - 1, resolved));
        if (latched > 0) {
            return latched;
        }
        if (clamped !== latched) {
            EntityHandler.serverAuthorityScopeLevels.set(scopeKey, clamped);
            console.log(`[DungeonDifficulty] ${scopeKey} run locked at enemy level ${clamped}`);
        }
        return clamped;
    }

    /**
     * Re-size every server-owned hostile in a scope to the run's current tier.
     *
     * Only runs when the tier actually changed, which is once per run at most in practice.
     * `normalizeServerAuthorityHostileState` preserves the absolute damage already dealt, so a
     * bigger pool leaves the enemy proportionally healthier rather than reviving it, and a dead
     * one stays dead.
     */
    private static rescaleServerAuthorityHostilesForScope(levelScope: string): void {
        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (!levelMap) {
            return;
        }

        const levelName = getScopeLevelName(levelScope);
        let rescaled = 0;
        for (const entity of levelMap.values()) {
            if (!EntityHandler.isServerAuthorityHostileEntity(levelName, entity)) {
                continue;
            }

            const oldMaxHp = Math.max(0, Math.round(Number(entity.maxHp ?? 0)));
            const newMaxHp = EntityHandler.estimateServerAuthorityHostileMaxHp(entity, levelScope);
            if (oldMaxHp === newMaxHp) {
                continue;
            }

            // Keep the *fraction* of health, not the absolute damage. Preserving absolute
            // damage is right when a pool is rebuilt at the same tier, but on a rescale it
            // hands a bigger pool back to an enemy that was nearly dead -- and to one that was
            // already dead, which is a corpse standing back up mid-fight.
            const dead = Boolean(entity.dead) || Boolean(entity.destroyed) ||
                Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD;
            const oldHp = Math.max(0, Math.round(Number(entity.hp ?? oldMaxHp)));
            const remainingFraction = oldMaxHp > 0 ? Math.max(0, Math.min(1, oldHp / oldMaxHp)) : 1;
            const newHp = dead ? 0 : Math.max(1, Math.round(newMaxHp * remainingFraction));

            entity.level = EntityHandler.resolveServerAuthorityEntityLevel(levelScope);
            entity.maxHp = newMaxHp;
            entity.hp = newHp;
            entity.healthDelta = newHp - newMaxHp;
            entity.health_delta = entity.healthDelta;
            rescaled++;
        }

        if (rescaled > 0) {
            console.log(`[DungeonDifficulty] ${levelScope} resized ${rescaled} hostiles to the new tier`);
        }
    }

    /** Drop a finished run's latched difficulty so the next run sizes itself from its own party. */
    static forgetServerAuthorityScopeLevel(levelScope: string): void {
        if (levelScope) {
            EntityHandler.serverAuthorityScopeLevels.delete(levelScope);
        }
    }

    static estimateServerAuthorityHostileMaxHp(entity: any, levelNameOrScope?: string | null): number {
        const entType = GameData.getEntType(String(entity?.name ?? '')) ?? {};
        const hitPointScale = Number(entity?.HitPoints ?? entity?.hitPoints ?? entType?.HitPoints ?? NaN);

        // Sized the way the CLIENT sizes it, from the type's own level.
        //
        // The client has six places that set an entity's level, and the one that adds the run's
        // `mBonusLevels` is not the one a hostile spawned from a level cue takes -- those read
        // `entType.baseLevel` and nothing else. So the offset we send reaches these bodies never,
        // and any tier the server picks for itself is a number only the server has.
        //
        // Every symptom of that gap is the same one: the player kills what is on their screen,
        // the canonical keeps the difference, and the enemy stands for everyone else. Measured
        // at its worst, a ShadeWarrior recorded at 26912 died to 8572 of damage -- the client
        // was fighting a tier 26 body the whole time.
        //
        // So the server stops choosing. It mirrors the type's own level, both sides compute the
        // same pool from the same two numbers, and a kill lands on the canonical by arithmetic
        // rather than by inference. Scaling a run above that needs the client to be told, and
        // the only place that would work is a patch at those `entType.baseLevel` writes.
        const entTypeLevel = Math.round(Number(
            entity?.baseLevel ?? entType?.Level ?? entType?.baseLevel ?? entType?.ExpLevel ?? 0
        ));
        if (Number.isFinite(entTypeLevel) && entTypeLevel > 0 && Number.isFinite(hitPointScale) && hitPointScale > 0) {
            const clamped = Math.max(1, Math.min(EntityHandler.HOSTILE_BASE_HITPOINTS.length - 1, entTypeLevel));
            return Math.max(1, Math.round(EntityHandler.getHostileBaseHpForLevel(clamped) * hitPointScale));
        }

        const entityLevel = EntityHandler.resolveServerAuthorityEntityLevel(
            levelNameOrScope ?? entity?.levelScope ?? entity?.levelName
        );
        const baseHp = EntityHandler.getHostileBaseHpForLevel(entityLevel);
        if (!Number.isFinite(hitPointScale) || hitPointScale <= 0) {
            return Math.max(1, baseHp);
        }

        return Math.max(1, Math.round(baseHp * hitPointScale));
    }

    /**
     * How much damage it takes to be sure a client kills its own copy of a hostile.
     *
     * Sizing this from the canonical's pool looked obvious and is wrong, because the two sides
     * do not always agree on how big the enemy is. The East Wing roster holds
     * `PortalFiend canonicalHp=135/135` next to `ShadeWarrior 26912` and
     * `GreaterDemonMaligner 161472`; a burial sized at 135 is a scratch to a client copy with
     * the real pool, so those enemies stayed alive on a joiner's screen while being long dead
     * on everybody else's -- dead for the run, dead for the member who killed them, standing
     * for the one who arrived later.
     *
     * So take the largest credible pool: the canonical's, the copy the server has cached for
     * that viewer, and the level-scaled estimate for the type. Overshooting costs nothing --
     * the client's TakeDamage stops at the health the entity actually has.
     */
    static resolveLethalHostileDelta(
        levelNameOrScope: string | null | undefined,
        canonical: any,
        localCopy: any = null
    ): number {
        const canonicalMaxHp = Math.max(0, Math.round(Number(canonical?.maxHp ?? 0)) || 0);
        const localMaxHp = Math.max(0, Math.round(Number(localCopy?.maxHp ?? 0)) || 0);
        const estimated = Math.max(
            0,
            Math.round(Number(EntityHandler.estimateServerAuthorityHostileMaxHp(canonical ?? localCopy, levelNameOrScope) ?? 0)) || 0
        );

        // Big enough to kill anything the health table can produce, on purpose.
        //
        // Every estimate here is the SERVER's idea of the pool, and the body being buried is the
        // CLIENT's. The two are supposed to agree -- both build from the run's tier -- but the
        // tier now travels in a packet (`Game.mBonusLevels`), and anything that arrives late,
        // out of order, or after a body was already spawned puts them out of step. When that
        // happens a burial sized from the server's number is simply too small, the copy survives
        // it, and the enemy stands on that screen for the rest of the run: dead for the party,
        // alive for one member. That failure has come back three times in this dungeon under
        // three different causes, so this stops depending on the estimate at all.
        //
        // The largest pool the table can express is base level 50 (134560) times the largest
        // HitPoints multiplier in EntTypes, which is single digits. Sixteen times that is past
        // anything reachable, and overshooting is free: the client's TakeDamage stops at the
        // health the entity actually has, and 0x78 is delivered with the damage floater
        // suppressed, so nothing is drawn for the excess.
        const lethalFloor = EntityHandler.HOSTILE_BASE_HITPOINTS[EntityHandler.HOSTILE_BASE_HITPOINTS.length - 1] * 16;
        return Math.max(1, canonicalMaxHp, localMaxHp, estimated, lethalFloor);
    }

    /**
     * Chests, kept deliberately out of the hostile machinery.
     *
     * They look like hostiles -- `team=2`, a health pool, `clientSpawned` -- and the first
     * attempt at sharing them leaned on that, giving each one a canonical so the enemy code
     * could carry it. It could, and it also carried everything else: the reconcile swept them,
     * and chests vanished before anyone opened them. A chest has none of the problems that
     * machinery exists for. It is opened once, by one person, and every other screen simply
     * needs to be told.
     *
     * So this is the whole model: a set of opened chests per run, keyed by where the chest
     * stands. Two members at the same chest report it from the same place, so the cue is
     * identity enough -- and it survives the rename that opening causes
     * (`TreasureChestMedium` becomes `TreasureChestEmpty`), which a name never would.
     */
    private static readonly CHEST_ENTITY_NAMES = new Set<string>([
        'treasurechestmedium',
        'treasurechestlarge',
        'questtreasurechest',
        'treasurechestempty'
    ]);
    // Tight on purpose. This was 400px, which is not "the same chest" -- it is "somewhere near
    // that side of the room", and a room can stand two chests inside it. The live capture caught
    // exactly that: one member opened a chest, opened a second one a few hundred pixels away, and
    // the run read the second as a repeat of the first -- so it paid nothing and, worse, was
    // never broken on anybody else's screen. It then stood there unopened for the joiner, which
    // is the chest that "respawned".
    //
    // A chest does not move, and both clients spawn it from the same cue, so the two reports of
    // one chest land on the same coordinate give or take rounding. 64px is far more than that
    // and far less than the gap between two chests.
    private static readonly CHEST_MATCH_RADIUS_SQ = 64 * 64;
    private static readonly openedChestsByScope = new Map<string, Array<{ x: number; y: number }>>();

    static isChestEntity(entity: any): boolean {
        if (!entity || entity.isPlayer) {
            return false;
        }
        return EntityHandler.CHEST_ENTITY_NAMES.has(EntityHandler.normalizeIdentityName(
            entity.entType ?? entity.EntType ?? entity.name ?? entity.EntName
        ));
    }

    /**
     * Where each client's chest actually stands, remembered from the moment it spawned.
     *
     * The position a chest reports later is not reliable. A capture had two chests spawn at
     * `16546,6659` and `15104,6619`, and then BOTH of their reward requests arrive carrying the
     * first coordinate -- so the second was recorded on top of the first, its own cue was never
     * marked opened, and it stood back up for the joiner. The spawn is the one report that
     * cannot be confused: it comes from the cue that placed the chest, and it names the entity.
     */
    private static readonly chestSpawnPositions = new Map<string, Map<string, { x: number; y: number }>>();

    static noteChestSpawnPosition(client: Client, levelScope: string, localId: number, x: number, y: number): void {
        const scopeKey = String(levelScope ?? '').trim();
        const id = Math.max(0, Math.round(Number(localId) || 0));
        if (!scopeKey || id <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        const byChest = EntityHandler.chestSpawnPositions.get(scopeKey) ?? new Map<string, { x: number; y: number }>();
        byChest.set(`${client.token}:${id}`, { x: Math.round(x), y: Math.round(y) });
        EntityHandler.chestSpawnPositions.set(scopeKey, byChest);
    }

    static resolveChestPosition(
        client: Client,
        levelScope: string,
        localId: number,
        fallbackX: number,
        fallbackY: number
    ): { x: number; y: number } | null {
        const scopeKey = String(levelScope ?? '').trim();
        const id = Math.max(0, Math.round(Number(localId) || 0));
        const spawned = id > 0 ? EntityHandler.chestSpawnPositions.get(scopeKey)?.get(`${client.token}:${id}`) : undefined;
        if (spawned) {
            return spawned;
        }
        return Number.isFinite(fallbackX) && Number.isFinite(fallbackY)
            ? { x: Math.round(fallbackX), y: Math.round(fallbackY) }
            : null;
    }

    static forgetChestSpawnPositions(levelScope: string): void {
        EntityHandler.chestSpawnPositions.delete(String(levelScope ?? ''));
    }
    static isChestOpened(levelScope: string, x: number, y: number): boolean {
        const opened = EntityHandler.openedChestsByScope.get(String(levelScope ?? ''));
        if (!opened || !Number.isFinite(x) || !Number.isFinite(y)) {
            return false;
        }
        return opened.some((chest) =>
            (((chest.x - x) ** 2) + ((chest.y - y) ** 2)) <= EntityHandler.CHEST_MATCH_RADIUS_SQ);
    }

    static forgetOpenedChests(levelScope: string): void {
        EntityHandler.openedChestsByScope.delete(String(levelScope ?? ''));
    }

    /**
     * Record an opened chest and break it on every other screen that still has one there.
     *
     * Returns false when the run had already opened this chest, which is what stops it paying
     * a second time: the other member's copy breaks because we broke it, and their client asks
     * for the gold exactly as if they had done it themselves.
     */
    private static readonly paidChestClaims = new Map<string, Set<string>>();

    static forgetPaidChestClaims(levelScope: string): void {
        EntityHandler.paidChestClaims.delete(String(levelScope ?? ''));
    }

    /**
     * Whether this exact chest has already been paid for.
     *
     * Position answers "which chest is standing there", and that is the right key for breaking
     * one on somebody else's screen. It is the wrong key for money: a capture caught one member
     * opening four chests that all reported the SAME coordinate at reward time, with four
     * different gold rolls -- so paying by position swallowed three real chests. The identity of
     * a payout is the entity that was opened, which the client names, and which is unique per
     * chest even when the coordinate is not.
     */
    static claimChestPayout(levelScope: string, opener: Client, sourceId: number): boolean {
        const scopeKey = String(levelScope ?? '').trim();
        const id = Math.max(0, Math.round(Number(sourceId) || 0));
        if (!scopeKey || id <= 0) {
            return true;
        }

        const key = `${opener.token}:${id}`;
        const paid = EntityHandler.paidChestClaims.get(scopeKey) ?? new Set<string>();
        if (paid.has(key)) {
            return false;
        }
        paid.add(key);
        EntityHandler.paidChestClaims.set(scopeKey, paid);
        return true;
    }

    static noteChestOpened(opener: Client, levelScope: string, x: number, y: number): boolean {
        const scopeKey = String(levelScope ?? '');
        if (!scopeKey || !Number.isFinite(x) || !Number.isFinite(y)) {
            return true;
        }
        if (EntityHandler.isChestOpened(scopeKey, x, y)) {
            console.log(
                `[Chest] ${scopeKey} ${String(opener.character?.name ?? '?')} asked again for the chest ` +
                `at ${Math.round(x)},${Math.round(y)} -- already opened`
            );
            return false;
        }

        const opened = EntityHandler.openedChestsByScope.get(scopeKey) ?? [];
        opened.push({ x: Math.round(x), y: Math.round(y) });
        EntityHandler.openedChestsByScope.set(scopeKey, opened);
        console.log(
            `[Chest] ${scopeKey} opened by ${String(opener.character?.name ?? '?')} ` +
            `at ${Math.round(x)},${Math.round(y)}`
        );

        for (const viewer of GlobalState.getSessionsInLevelScope(scopeKey)) {
            if (viewer === opener || !viewer.playerSpawned || getClientLevelScope(viewer) !== scopeKey) {
                continue;
            }
            EntityHandler.breakChestOnScreen(viewer, x, y);
        }
        return true;
    }

    /** Break whatever chest this viewer is holding at that spot. */
    static breakChestOnScreen(viewer: Client, x: number, y: number): boolean {
        for (const [localId, entity] of viewer.entities.entries()) {
            if (!EntityHandler.isChestEntity(entity)) {
                continue;
            }
            const dx = Number(entity.x ?? NaN) - x;
            const dy = Number(entity.y ?? NaN) - y;
            if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
                continue;
            }
            if (((dx * dx) + (dy * dy)) > EntityHandler.CHEST_MATCH_RADIUS_SQ) {
                continue;
            }
            EntityHandler.sendChestBreak(viewer, Math.round(Number(localId)), entity);
            return true;
        }
        return false;
    }

    /**
     * The same three packets that bury a hostile, for the same reason: 0x07 and 0x0D are
     * dropped by the client for a body it spawned itself, and only the damage lands.
     */
    static sendChestBreak(viewer: Client, localId: number, entity: any): void {
        if (localId <= 0) {
            return;
        }
        console.log(
            `[Chest] broke ${String(entity?.name ?? '?')} on ${String(viewer.character?.name ?? '?')}:${localId} ` +
            `at ${Math.round(Number(entity?.x ?? 0))},${Math.round(Number(entity?.y ?? 0))}`
        );
        const lethal = EntityHandler.resolveLethalHostileDelta(getClientLevelScope(viewer), entity, entity);
        viewer.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -lethal));
        viewer.send(0x07, EntityHandler.buildEntityStateDeadPayload(localId));
        viewer.send(0x0D, EntityHandler.buildDestroyEntityPayload(localId));
        viewer.entities.delete(localId);
        viewer.knownEntityIds.delete(localId);
    }
    static isServerAuthorityHostileEntity(levelNameOrScope: string | null | undefined, entity: any): boolean {
        return EntityHandler.usesServerAuthorityHostiles(getScopeLevelName(String(levelNameOrScope ?? ''))) &&
            Boolean(entity) &&
            !Boolean(entity?.isPlayer) &&
            !Boolean(entity?.clientSpawned) &&
            Number(entity?.team ?? 0) === EntityTeam.ENEMY;
    }

    static normalizeServerAuthorityHostileState(levelNameOrScope: string | null | undefined, entity: any): void {
        if (!EntityHandler.isServerAuthorityHostileEntity(levelNameOrScope, entity)) {
            return;
        }

        const oldMaxHp = Math.max(0, Math.round(Number(entity.maxHp ?? 0)));
        const oldHp = Math.max(0, Math.round(Number(entity.hp ?? (oldMaxHp || 0))));
        const oldDamage = oldMaxHp > 0 ? Math.max(0, oldMaxHp - oldHp) : 0;
        const maxHp = EntityHandler.estimateServerAuthorityHostileMaxHp(entity, levelNameOrScope);
        const dead = Boolean(entity.dead) ||
            Boolean(entity.destroyed) ||
            Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD ||
            (Number.isFinite(Number(entity.hp)) && Math.round(Number(entity.hp)) <= 0);
        const hp = dead ? 0 : Math.max(1, Math.min(maxHp, maxHp - oldDamage));
        const healthDelta = hp - maxHp;

        entity.level = EntityHandler.resolveServerAuthorityEntityLevel(levelNameOrScope);
        entity.maxHp = maxHp;
        entity.hp = hp;
        entity.healthDelta = healthDelta;
        entity.health_delta = healthDelta;
        entity.dead = dead;
        entity.destroyed = dead ? Boolean(entity.destroyed) : false;
        entity.entState = dead ? EntityState.DEAD : Number(entity.entState ?? EntityState.SLEEP);
        entity.clientSpawned = false;
    }

    private static createServerAuthorityEntityFromNpc(client: Client, levelName: string, npc: NpcDef): EntityProps {
        const entityProps = {
            ...Entity.fromNpc(npc),
            clientSpawned: false,
            canonicalId: Number(npc.canonicalId ?? npc.id ?? 0),
            entType: String(npc.entType ?? npc.name ?? ''),
            spawnKey: String(npc.spawnKey ?? ''),
            spawnIndex: Number(npc.spawnIndex ?? 0),
            levelId: String(npc.levelId ?? ''),
            levelName: String(npc.levelName ?? levelName),
            dungeonName: String(npc.dungeonName ?? ''),
            generatedFromScript: Boolean(npc.generatedFromScript),
            spawnSource: String(npc.spawnSource ?? ''),
            requiredForClear: Boolean(npc.requiredForClear),
            boss: Boolean(npc.boss),
            miniboss: Boolean(npc.miniboss),
            roomBoss: Boolean(npc.roomBoss),
            isRoomBoss: Boolean(npc.isRoomBoss ?? npc.roomBoss),
            roomBossName: String(npc.roomBossName ?? npc.displayName ?? ''),
            displayName: String(npc.displayName ?? npc.roomBossName ?? ''),
            scripted: Boolean(npc.scripted),
            sourceRoom: String(npc.sourceRoom ?? ''),
            sourceVar: String(npc.sourceVar ?? ''),
            sourceLine: Number(npc.sourceLine ?? 0),
            sourceSymbolId: Number(npc.sourceSymbolId ?? 0),
            sourceCharacterId: Number(npc.sourceCharacterId ?? 0),
            sourceSwf: String(npc.sourceSwf ?? ''),
            sourceLevelClass: String(npc.sourceLevelClass ?? ''),
            sourceExtractor: String(npc.sourceExtractor ?? ''),
            groupId: npc.groupId ?? null,
            waveId: npc.waveId ?? null,
            triggerId: npc.triggerId ?? null
        } as EntityProps & Record<string, unknown>;
        // Where the cue PUT it, kept apart from where it currently is.
        //
        // A joiner's client spawns its own copies from those same cues, so this is the one
        // coordinate the two sides agree on -- and unlike `x`/`y` it does not move when the
        // enemy chases somebody across the room or dies over there. Set here rather than in
        // `seedServerAuthorityHostiles`, because the roster is built by the NPC pass in
        // `sendInitialLevelEntities` and the seed only fills in what that pass left out.
        // See findServerAuthorityProxyCanonical, which matches against it.
        (entityProps as any).spawnAnchorX = Number((entityProps as any).x ?? 0);
        (entityProps as any).spawnAnchorY = Number((entityProps as any).y ?? 0);
        EntityHandler.applyRuntimeDungeonEntityLevel(client, levelName, entityProps);
        return entityProps;
    }

    private static seedServerAuthorityHostiles(client: Client, levelName: string, levelMap: Map<number, any>): void {
        if (!EntityHandler.usesServerAuthorityHostiles(levelName)) {
            return;
        }

        const levelScope = getLevelScopeKey(levelName, client.levelInstanceId);
        if (!levelScope || EntityHandler.serverAuthoritySeededScopes.has(levelScope)) {
            return;
        }

        // Settle the run's tier before a single hostile is built, so every pool in this scope is
        // sized from the same number. Resolving it lazily let the tier rise *during* a fight --
        // the pools were recomputed mid-hit and the enemy inflated back out of the damage that
        // had just been dealt to it.
        EntityHandler.resolveServerAuthorityEntityLevel(levelScope);

        const destroyedIds = EntityHandler.getServerAuthorityDestroyedIds(levelScope);

        for (const npc of NpcLoader.getNpcsForLevel(levelName)) {
            const npcId = Math.max(0, Math.round(Number(npc.id ?? 0)));
            if (npcId <= 0 || destroyedIds.has(npcId) || levelMap.has(npcId)) {
                continue;
            }

            const entityProps = EntityHandler.createServerAuthorityEntityFromNpc(client, levelName, npc);
            (entityProps as any).spawnKey = (entityProps as any).spawnKey || EntityHandler.getHostileSpawnKey(levelScope, entityProps);
            if (EntityHandler.findDeadServerAuthorityHostileTombstone(levelScope, entityProps)) {
                continue;
            }
            levelMap.set(npcId, entityProps);
        }

        EntityHandler.serverAuthoritySeededScopes.add(levelScope);
    }

    private static hasOtherActiveSessionInScope(client: Client, levelScope: string): boolean {
        for (const session of GlobalState.getSessionsInLevelScope(levelScope)) {
            if (
                session !== client &&
                session.playerSpawned &&
                !session.socket?.destroyed &&
                getClientLevelScope(session) === levelScope
            ) {
                return true;
            }
        }

        return false;
    }

    private static selectJcMini1PartyScopeAnchor(client: Client, levelName: string): Client | null {
        if (!EntityHandler.usesServerAuthorityHostiles(levelName) || getPartyIdForClient(client) <= 0) {
            return null;
        }

        let bestSession: Client | null = null;
        let bestStartedAt = Number.POSITIVE_INFINITY;
        // Scan live sessions, not `sessionsByPartyId`.
        //
        // This is the decision that says whether two party members are even in the same
        // dungeon, and `getSessionsInParty` returns whatever is in the party index -- including
        // an *incomplete* set, which it hands back as authoritative because a present-but-short
        // entry is indistinguishable from a correct one. Missing the party mate here means no
        // anchor, which means this player keeps their own instance id: a private run with their
        // own copies of every enemy, standing in the same room as somebody they can never see
        // and whose kills never register. Party membership itself is read from `partyByMember`
        // by `areClientsInSameParty`, which is the authoritative map, so filtering live sessions
        // through it cannot go stale. This runs on level entry and full updates, not per frame.
        for (const session of GlobalState.sessionsByToken.values()) {
            if (
                session === client ||
                !session.playerSpawned ||
                !session.character ||
                !GlobalState.isSessionOpen(session) ||
                LevelConfig.normalizeLevelName(session.currentLevel) !== levelName ||
                !areClientsInSameParty(client, session)
            ) {
                continue;
            }

            const startedAt = Math.max(0, Math.round(Number(session.syncAnchorStartedAt ?? 0) || 0));
            const comparableStartedAt = startedAt > 0 ? startedAt : Number.MAX_SAFE_INTEGER;
            if (
                !bestSession ||
                comparableStartedAt < bestStartedAt ||
                (comparableStartedAt === bestStartedAt && session.token < bestSession.token)
            ) {
                bestSession = session;
                bestStartedAt = comparableStartedAt;
            }
        }

        return bestSession;
    }

    private static moveClientOwnedEntitiesBetweenScopes(client: Client, oldScope: string, newScope: string): void {
        if (!oldScope || !newScope || oldScope === newScope) {
            return;
        }

        const oldMap = GlobalState.levelEntities.get(oldScope);
        if (!oldMap) {
            return;
        }

        let newMap = GlobalState.levelEntities.get(newScope);
        if (!newMap) {
            newMap = new Map<number, any>();
            GlobalState.levelEntities.set(newScope, newMap);
        }

        let moved = 0;
        const charNameNorm = EntityHandler.normalizeIdentityName(client.character?.name);
        for (const [entityId, entity] of Array.from(oldMap.entries())) {
            const isOwnedPlayer = Boolean(entity?.isPlayer) && (
                (client.clientEntID > 0 && entityId === client.clientEntID) ||
                (charNameNorm && EntityHandler.normalizeIdentityName(entity?.name) === charNameNorm)
            );
            const isOwnedClientSpawn = Boolean(entity?.clientSpawned) && Number(entity?.ownerToken ?? 0) === client.token;
            if (!isOwnedPlayer && !isOwnedClientSpawn) {
                continue;
            }

            oldMap.delete(entityId);
            newMap.set(entityId, entity);
            moved++;
        }

        EntityHandler.carryServerAuthorityRunBetweenScopes(oldScope, newScope, oldMap, newMap);

        if (oldMap.size === 0) {
            GlobalState.levelEntities.delete(oldScope);
        }
    }

    /**
     * Take the run itself along when a scope is re-keyed.
     *
     * This function used to move only the client's OWN entities -- its player body and the
     * hostiles it spawned, both of which carry `ownerToken`. A canonical hostile carries
     * neither: it is `clientSpawned: false` with `ownerToken: 0`, so the entire shared roster,
     * and with it every death the run had recorded, was left behind in the old key. The next
     * `sendInitialLevelEntities` then found no map at the new key and seeded a fresh one --
     * all 35 enemies alive again.
     *
     * That is the whole of "the enemies respawned when the second player joined". It needs no
     * reset to happen and it logs nothing, because from the server's point of view this is
     * simply a new scope that has never been played. The live report was `live=34` on a run
     * whose first member had already cleared a room, and a progress bar reading 2% against
     * their 25%.
     *
     * Only ever carried into an EMPTY destination. A destination that already holds canonical
     * hostiles is a run in its own right, and the arriving member joins it rather than
     * overwriting it -- the same rule the entity binding already follows.
     */
    private static carryServerAuthorityRunBetweenScopes(
        oldScope: string,
        newScope: string,
        oldMap: Map<number, any>,
        newMap: Map<number, any>
    ): void {
        const levelName = getScopeLevelName(oldScope);
        if (!EntityHandler.usesServerAuthorityHostiles(levelName) || getScopeLevelName(newScope) !== levelName) {
            return;
        }

        // A pristine roster is not a run. It is seeding.
        //
        // The destination usually holds hostiles already -- somebody entered and the level was
        // populated for them -- and refusing to carry into it looked like the safe choice. It is
        // not: the party then lands on that untouched roster and every enemy they had fought
        // stands back up at full health. The live capture caught it exactly, one canonical
        // walked down to 4932/26912 by both members and then reported at 26912/26912 the moment
        // the scope re-keyed.
        //
        // So the test is not "are there hostiles here" but "has anything happened to them". A
        // destination where nothing is dead and nothing is damaged has no history to lose, and
        // the run being carried in does.
        const destinationHostiles = Array.from(newMap.values())
            .filter((entity) => EntityHandler.isServerAuthorityHostileEntity(levelName, entity));
        const destinationHasHistory = destinationHostiles.some((entity) =>
            EntityHandler.isEntityDead(entity) ||
            Math.round(Number(entity?.hp ?? 0)) < Math.round(Number(entity?.maxHp ?? 0)));
        if (destinationHasHistory) {
            return;
        }

        const sourceHasHistory = Array.from(oldMap.values()).some((entity) =>
            EntityHandler.isServerAuthorityHostileEntity(levelName, entity) &&
            (
                EntityHandler.isEntityDead(entity) ||
                Math.round(Number(entity?.hp ?? 0)) < Math.round(Number(entity?.maxHp ?? 0))
            ));
        if (destinationHostiles.length > 0 && !sourceHasHistory) {
            return;
        }

        // Clear the pristine roster out of the way so the run replaces it rather than merging
        // with it -- two rosters in one scope would double every count the dungeon keeps.
        for (const entity of destinationHostiles) {
            newMap.delete(Math.max(0, Math.round(Number(entity?.id ?? 0))));
        }

        let carried = 0;
        for (const [entityId, entity] of Array.from(oldMap.entries())) {
            if (!EntityHandler.isServerAuthorityHostileEntity(levelName, entity)) {
                continue;
            }
            oldMap.delete(entityId);
            newMap.set(entityId, entity);
            carried++;
        }
        if (carried === 0) {
            return;
        }

        // The roster alone is not the run. Its death bookkeeping is keyed by scope too, and
        // leaving that behind would let a joiner's fresh copies of already-killed enemies bind
        // and stand up again, and would reopen the progress at zero.
        EntityHandler.moveScopeKeyedEntry(EntityHandler.serverAuthorityDestroyedIdsByScope, oldScope, newScope);
        EntityHandler.moveScopeKeyedEntry(EntityHandler.serverAuthorityDestroyedFingerprintsByScope, oldScope, newScope);
        EntityHandler.moveScopeKeyedEntry(GlobalState.deadServerAuthorityHostilesByScope, oldScope, newScope);
        EntityHandler.moveScopeKeyedEntry(GlobalState.levelQuestProgress, oldScope, newScope);
        // The opened chests are part of the run too. Leaving them behind would stand every one
        // of them back up the moment the scope was re-keyed.
        EntityHandler.moveScopeKeyedEntry(EntityHandler.openedChestsByScope, oldScope, newScope);
        EntityHandler.moveScopeKeyedEntry(EntityHandler.paidChestClaims, oldScope, newScope);
        EntityHandler.moveScopeKeyedEntry(EntityHandler.chestSpawnPositions, oldScope, newScope);
        // The tier is latched per scope, and these enemies are already sized to it. Dropping it
        // would leave the roster at the old tier while the new key resolved a different one.
        EntityHandler.moveScopeKeyedEntry(EntityHandler.serverAuthorityScopeLevels, oldScope, newScope);
        if (EntityHandler.serverAuthoritySeededScopes.delete(oldScope)) {
            EntityHandler.serverAuthoritySeededScopes.add(newScope);
        }

        console.log(
            `[EntityHandler] Carried the ${levelName} run from ${oldScope} to ${newScope} ` +
            `(${carried} canonical hostiles) rather than reseeding it`
        );
    }

    private static moveScopeKeyedEntry<V>(store: Map<string, V>, oldScope: string, newScope: string): void {
        if (store.has(newScope) || !store.has(oldScope)) {
            return;
        }
        store.set(newScope, store.get(oldScope) as V);
        store.delete(oldScope);
    }

    private static emitJcMini1PartyScopeSnapshot(client: Client, levelName: string, reason: string): void {
        if (!EntityHandler.usesServerAuthorityHostiles(levelName) || getPartyIdForClient(client) <= 0) {
            return;
        }

        const partyMembers: any[] = [];
        for (const session of GlobalState.getSessionsInParty(getPartyIdForClient(client))) {
            if (!session.character || !areClientsInSameParty(client, session)) {
                continue;
            }

            partyMembers.push({
                token: session.token,
                name: session.character.name,
                level: session.currentLevel,
                levelInstanceId: session.levelInstanceId,
                scope: getClientLevelScope(session),
                roomId: session.currentRoomId,
                playerSpawned: Boolean(session.playerSpawned),
                hp: Math.round(Number(session.authoritativeCurrentHp ?? 0)),
                maxHp: Math.round(Number(session.authoritativeMaxHp ?? 0)),
                proxyCount: Array.from(session.entities?.values?.() ?? [])
                    .filter((entity: any) => Number(entity?.team ?? 0) === EntityTeam.ENEMY && Number(entity?.canonicalEntityId ?? 0) > 0)
                    .length
            });
        }
    }

    static ensureJcMini1PartySharedScope(client: Client, rawLevelName: string | null | undefined, reason: string): string {
        const levelName = LevelConfig.normalizeLevelName(rawLevelName) || '';
        if (!EntityHandler.usesServerAuthorityHostiles(levelName)) {
            return getLevelScopeKey(rawLevelName, client.levelInstanceId);
        }

        const oldInstanceId = String(client.levelInstanceId ?? '');
        const oldScope = getLevelScopeKey(levelName, oldInstanceId);
        const anchor = EntityHandler.selectJcMini1PartyScopeAnchor(client, levelName);
        const anchorInstanceId = anchor
            ? (String(anchor.levelInstanceId ?? '').trim() || (anchor.token > 0 ? String(anchor.token) : ''))
            : '';
        const targetInstanceId = anchorInstanceId || oldInstanceId.trim() || (client.token > 0 ? String(client.token) : '');
        if (!targetInstanceId) {
            EntityHandler.emitJcMini1PartyScopeSnapshot(client, levelName, reason);
            return oldScope;
        }

        if (anchor && String(anchor.levelInstanceId ?? '') !== targetInstanceId) {
            const anchorOldScope = getLevelScopeKey(levelName, anchor.levelInstanceId);
            anchor.levelInstanceId = targetInstanceId;
            EntityHandler.moveClientOwnedEntitiesBetweenScopes(anchor, anchorOldScope, getLevelScopeKey(levelName, targetInstanceId));
            GlobalState.refreshSessionIndexes(anchor);
        }

        const newScope = getLevelScopeKey(levelName, targetInstanceId);
        if (oldScope !== newScope || oldInstanceId !== targetInstanceId) {
            client.levelInstanceId = targetInstanceId;
            EntityHandler.moveClientOwnedEntitiesBetweenScopes(client, oldScope, newScope);
            GlobalState.refreshSessionIndexes(client);
        }

        EntityHandler.emitJcMini1PartyScopeSnapshot(client, levelName, reason);
        return newScope;
    }

    private static clientKnowsServerAuthorityHostile(client: Client, levelMap: Map<number, any>): boolean {
        for (const [entityId, entity] of levelMap.entries()) {
            if (
                EntityHandler.isServerAuthorityHostileEntity(client.currentLevel, entity) &&
                (client.knownEntityIds?.has(entityId) || client.entities?.has(entityId))
            ) {
                return true;
            }
        }

        return false;
    }

    private static normalizeServerAuthorityProxyName(value: unknown): string {
        const normalized = EntityHandler.normalizeIdentityName(value);
        return normalized.endsWith('hard') ? normalized.slice(0, -4) : normalized;
    }

    private static findServerAuthorityProxyCanonical(
        levelName: string | null | undefined,
        levelMap: Map<number, any> | null,
        entity: any
    ): any | null {
        if (!EntityHandler.usesServerAuthorityHostiles(levelName) || !levelMap || !entity || entity.isPlayer) {
            return null;
        }

        const proxyName = EntityHandler.normalizeServerAuthorityProxyName(
            entity.name ?? entity.EntName ?? entity.entName ?? entity.characterName ?? entity.character_name
        );
        if (!proxyName) {
            return null;
        }

        let bestMatch: any | null = null;
        let bestDistanceSq = Number.POSITIVE_INFINITY;
        const proxyX = Number(entity.x ?? NaN);
        const proxyY = Number(entity.y ?? NaN);
        const hasProxyPosition = Number.isFinite(proxyX) && Number.isFinite(proxyY);

        const requireClosePosition = EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelName) && hasProxyPosition;
        for (const candidate of levelMap.values()) {
            if (!EntityHandler.isServerAuthorityHostileEntity(levelName, candidate)) {
                continue;
            }
            if (EntityHandler.normalizeServerAuthorityProxyName(candidate.name) !== proxyName) {
                continue;
            }

            // Measured to where the cue PUT this enemy, not to where it is standing now.
            //
            // A joiner's copy always arrives on its cue's spawn point, so the anchor is the
            // coordinate the two sides agree on. The live position is not: an enemy that
            // chased somebody across the room -- or died over there -- drags its `x`/`y` with
            // it, and a fresh copy then binds to whichever same-named body drifted closest.
            // In a room holding several of one type that swaps their identities, which stands
            // a dead enemy back up on the joiner's screen and buries a live one in its place.
            const candidateX = Number(candidate.spawnAnchorX ?? candidate.x ?? NaN);
            const candidateY = Number(candidate.spawnAnchorY ?? candidate.y ?? NaN);
            const distanceSq = hasProxyPosition && Number.isFinite(candidateX) && Number.isFinite(candidateY)
                ? ((candidateX - proxyX) * (candidateX - proxyX)) + ((candidateY - proxyY) * (candidateY - proxyY))
                : 0;
            if (
                requireClosePosition &&
                Number.isFinite(candidateX) &&
                Number.isFinite(candidateY) &&
                distanceSq > EntityHandler.CANONICAL_VISIBLE_PROXY_MATCH_MAX_DISTANCE_SQ
            ) {
                continue;
            }
            if (distanceSq < bestDistanceSq) {
                bestDistanceSq = distanceSq;
                bestMatch = candidate;
            }
        }

        return bestMatch;
    }

    private static findExistingServerAuthorityProxyLocalId(
        client: Client,
        canonicalId: number,
        exceptLocalId: number
    ): number {
        const canonical = Math.max(0, Math.round(Number(canonicalId) || 0));
        const except = Math.max(0, Math.round(Number(exceptLocalId) || 0));
        if (canonical <= 0) {
            return 0;
        }

        for (const [localId, mappedCanonicalId] of (client.entityIdAliases ?? new Map<number, number>()).entries()) {
            const local = Math.max(0, Math.round(Number(localId) || 0));
            if (
                local > 0 &&
                local !== except &&
                Math.max(0, Math.round(Number(mappedCanonicalId) || 0)) === canonical &&
                client.entities.has(local)
            ) {
                return local;
            }
        }

        for (const [localId, localEntity] of client.entities.entries()) {
            const local = Math.max(0, Math.round(Number(localId) || 0));
            if (local <= 0 || local === except) {
                continue;
            }
            const localCanonical = Math.max(
                0,
                Math.round(Number(localEntity?.canonicalEntityId ?? localEntity?.sharedCanonicalId ?? 0) || 0)
            );
            if (localCanonical === canonical) {
                return local;
            }
        }

        return 0;
    }

    private static findClientLocalServerAuthorityProxyForCanonical(
        client: Client,
        levelName: string | null | undefined,
        canonical: any
    ): number {
        const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? 0) || 0));
        if (canonicalId <= 0) {
            return 0;
        }

        const canonicalName = EntityHandler.normalizeServerAuthorityProxyName(canonical?.name);
        if (!canonicalName) {
            return 0;
        }

        const canonicalX = Number(canonical?.x ?? NaN);
        const canonicalY = Number(canonical?.y ?? NaN);
        const hasCanonicalPosition = Number.isFinite(canonicalX) && Number.isFinite(canonicalY);
        const requireClosePosition = EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelName) && hasCanonicalPosition;
        let bestLocalId = 0;
        let bestDistanceSq = Number.POSITIVE_INFINITY;

        for (const [localId, localEntity] of client.entities.entries()) {
            const local = Math.max(0, Math.round(Number(localId) || 0));
            if (
                local <= 0 ||
                local === canonicalId ||
                localEntity?.isPlayer ||
                Number(localEntity?.team ?? 0) !== EntityTeam.ENEMY
            ) {
                continue;
            }
            if (EntityHandler.normalizeServerAuthorityProxyName(localEntity?.name) !== canonicalName) {
                continue;
            }

            const localX = Number(localEntity?.x ?? NaN);
            const localY = Number(localEntity?.y ?? NaN);
            const distanceSq = hasCanonicalPosition && Number.isFinite(localX) && Number.isFinite(localY)
                ? ((localX - canonicalX) * (localX - canonicalX)) + ((localY - canonicalY) * (localY - canonicalY))
                : 0;
            if (
                requireClosePosition &&
                Number.isFinite(localX) &&
                Number.isFinite(localY) &&
                distanceSq > EntityHandler.CANONICAL_VISIBLE_PROXY_MATCH_MAX_DISTANCE_SQ
            ) {
                continue;
            }
            if (distanceSq < bestDistanceSq) {
                bestDistanceSq = distanceSq;
                bestLocalId = local;
            }
        }

        return bestLocalId;
    }

    private static buildHpDeltaPayload(entityId: number, delta: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(delta);
        return bb.toBuffer();
    }

    /**
     * Take a body off one screen with no death and no corpse.
     *
     * 0x3B is a channel the game has never used. Its reader, LinkUpdater.method_1408, is
     * patched by scripts/patch-dungeonblitz-retire-entity-packet.ts to resolve the entity id
     * and set `Entity.var_1835` -- the engine's own retire-me tombstone, which Game.method_1970
     * answers on its next tick by destroying and splicing the entity itself. Both fields are
     * still read by the patched method (only its tail was replaced), so the wire shape is
     * unchanged and the second one is written and ignored; under-writing here would desync
     * every packet behind it in the buffer.
     *
     * This is the only removal that works on a hostile the client spawned from a level cue.
     * Those have no class_122 record, so 0x07 and 0x0D are discarded at the door and only 0x78
     * lands -- which kills the body rather than removing it, leaving the corpse lying there for
     * the client's ten-second TIME_MONSTER_LAYS_DEAD_BEFORE_VANISHING.
     *
     * It does NOT replace the burial. A burial is still sent first so the client runs its own
     * death path and counts the kill in the room bookkeeping its dungeon percentage comes from;
     * this only stops the corpse being drawn afterwards.
     */
    static retireClientLocalEntity(client: Client, rawEntityId: number, reason: string): void {
        const localId = Math.max(0, Math.round(Number(rawEntityId) || 0));
        if (localId <= 0) {
            return;
        }
        const bb = new BitBuffer(false);
        bb.writeMethod4(localId);
        bb.writeMethod4(0);
        client.send(0x3B, bb.toBuffer());
        console.log(
            `[HostileRetire] ${String(client.character?.name ?? '?')}:${localId} retired (${reason})`
        );
    }

    // The incremental-update shape, standing still. The client applies the deltas
    // to whatever position it currently believes, which is what makes this usable
    // to snap a stale local copy onto the shared enemy's real position.
    private static buildEntityCatchUpMovePayload(
        entityId: number,
        deltaX: number,
        deltaY: number,
        entState: number,
        facingLeft: boolean
    ): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(deltaX);
        bb.writeMethod45(deltaY);
        bb.writeMethod45(0);
        bb.writeMethod6(entState, 2);
        bb.writeMethod15(facingLeft);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        return bb.toBuffer();
    }

    private static sendServerAuthorityProxyInitialHpSync(
        client: Client,
        canonical: any,
        localEntityId: number,
        reason: string
    ): void {
        const localId = Math.max(0, Math.round(Number(localEntityId) || 0));
        const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? 0) || 0));
        const maxHp = Math.max(0, Math.round(Number(canonical?.maxHp ?? 0)));
        const hp = Math.max(0, Math.round(Number(canonical?.hp ?? 0)));
        if (localId <= 0 || canonicalId <= 0 || maxHp <= 0 || hp <= 0) {
            return;
        }

        const damageTaken = Math.max(0, maxHp - hp);
        client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, maxHp));
        if (damageTaken > 0) {
            client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -damageTaken));
        }
    }

    static ensureServerAuthorityProxyOwner(client: Client, canonicalEntity: any, localEntityId: number): boolean {
        if (!canonicalEntity || typeof canonicalEntity !== 'object') {
            return false;
        }

        const levelScope = getClientLevelScope(client);
        const canonicalId = Math.max(0, Math.round(Number(canonicalEntity.id ?? 0)));
        const localId = Math.max(0, Math.round(Number(localEntityId) || 0));
        const previousOwnerToken = Math.max(0, Math.round(Number(canonicalEntity.proxyOwnerToken ?? 0)));
        const previousOwner = previousOwnerToken > 0 ? GlobalState.sessionsByToken.get(previousOwnerToken) : null;
        const previousOwnerActive = Boolean(
            previousOwner?.playerSpawned &&
            !previousOwner.socket?.destroyed &&
            getClientLevelScope(previousOwner) === levelScope
        );
        const clientPreferred = EntityHandler.isPreferredServerAuthorityProxyOwner(client, levelScope);
        const previousOwnerPreferred = previousOwner
            ? EntityHandler.isPreferredServerAuthorityProxyOwner(previousOwner, levelScope)
            : false;

        if (!previousOwnerActive || (clientPreferred && !previousOwnerPreferred && previousOwnerToken !== client.token)) {
            canonicalEntity.proxyOwnerToken = client.token;
            canonicalEntity.proxyOwnerName = client.character?.name ?? '';
            canonicalEntity.proxyOwnerLocalId = localId;
            return true;
        }

        return previousOwnerToken === client.token;
    }

    private static isPreferredServerAuthorityProxyOwner(client: Client, levelScope: string): boolean {
        if (!client?.playerSpawned || getClientLevelScope(client) !== levelScope) {
            return false;
        }

        const instanceOwnerToken = Math.max(0, Math.round(Number(client.levelInstanceId ?? 0) || 0));
        if (instanceOwnerToken > 0 && client.token === instanceOwnerToken) {
            return true;
        }
        if (instanceOwnerToken > 0) {
            const instanceOwner = GlobalState.sessionsByToken.get(instanceOwnerToken);
            if (
                instanceOwner?.playerSpawned &&
                !instanceOwner.socket?.destroyed &&
                getClientLevelScope(instanceOwner) === levelScope
            ) {
                return false;
            }
        }

        let bestSession: Client | null = null;
        let bestStartedAt = Number.POSITIVE_INFINITY;
        for (const session of GlobalState.getSessionsInLevelScope(levelScope)) {
            if (
                !session.playerSpawned ||
                session.socket?.destroyed ||
                getClientLevelScope(session) !== levelScope ||
                !areClientsInSameParty(client, session)
            ) {
                continue;
            }

            const startedAt = Math.max(0, Math.round(Number(session.syncAnchorStartedAt ?? 0) || 0));
            const comparableStartedAt = startedAt > 0 ? startedAt : Number.MAX_SAFE_INTEGER;
            if (
                !bestSession ||
                comparableStartedAt < bestStartedAt ||
                (comparableStartedAt === bestStartedAt && session.token < bestSession.token)
            ) {
                bestSession = session;
                bestStartedAt = comparableStartedAt;
            }
        }

        if (bestSession) {
            return bestSession.token === client.token;
        }

        return isClientPartyLeader(client);
    }

    private static syncCanonicalVisibleServerAuthorityHostileFromProxy(
        client: Client,
        canonical: any,
        proxy: any,
        localEntityId: number
    ): void {
        if (!canonical || !proxy || typeof canonical !== 'object' || typeof proxy !== 'object') {
            return;
        }

        const ownerToken = Math.max(0, Math.round(Number(canonical.proxyOwnerToken ?? 0)));
        if (ownerToken > 0 && ownerToken !== client.token) {
            return;
        }

        const preservedHp = canonical.hp;
        const preservedMaxHp = canonical.maxHp;
        const preservedHealthDelta = canonical.healthDelta;
        const preservedHealthDeltaSnake = canonical.health_delta;
        const preservedDead = canonical.dead;
        const preservedUntargetable = canonical.untargetable;

        const fields = [
            'x',
            'y',
            'v',
            'renderDepthOffset',
            'characterName',
            'dramaAnim',
            'sleepAnim',
            'summonerId',
            'powerId',
            'facingLeft',
            'running',
            'jumping',
            'dropping',
            'backpedal',
            'roomId'
        ];
        for (const field of fields) {
            if (proxy[field] !== undefined) {
                canonical[field] = proxy[field];
            }
        }

        canonical.proxyOwnerLocalId = Math.max(0, Math.round(Number(localEntityId) || 0));
        canonical.lastProxyUpdateAt = Date.now();
        canonical.hp = preservedHp;
        canonical.maxHp = preservedMaxHp;
        canonical.healthDelta = preservedHealthDelta;
        canonical.health_delta = preservedHealthDeltaSnake;
        canonical.dead = preservedDead;
        canonical.untargetable = preservedUntargetable;
        canonical.clientSpawned = false;
    }

    private static fanOutCanonicalVisibleServerAuthorityHostile(
        source: Client,
        levelName: string | null | undefined,
        canonical: any
    ): void {
        if (!EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelName)) {
            return;
        }

        const levelScope = getClientLevelScope(source);
        const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? 0)));
        if (!levelScope || canonicalId <= 0) {
            return;
        }

        for (const viewer of GlobalState.getSessionsInLevelScope(levelScope)) {
            if (
                viewer === source ||
                !viewer.playerSpawned ||
                viewer.socket?.destroyed ||
                getClientLevelScope(viewer) !== levelScope
            ) {
                continue;
            }

            const localId = EntityHandler.findClientLocalServerAuthorityProxyForCanonical(viewer, levelName, canonical);
            if (localId <= 0) {
                continue;
            }

            EntityHandler.bridgeCanonicalVisibleServerAuthorityProxy(
                viewer,
                levelName,
                canonical,
                viewer.entities.get(localId),
                localId,
                Boolean(canonical.dead) || Number(canonical.entState ?? EntityState.ACTIVE) === EntityState.DEAD,
                'first_sight_owner_canonical_fanout'
            );
        }
    }

    /**
     * Whether this client is holding a body of this enemy, and may therefore report its death.
     *
     * `isServerAuthorityProxyOwner` answers a different question: which ONE session drives the
     * canonical. That is the right rule for movement, and the wrong one for a kill. Every member
     * spawns and fights their own copy, so every member is the authority on the copy in front of
     * them -- but the accept gates asked for proxy ownership, which exactly one of them can hold.
     * With two players it usually landed on whoever was driving; with a third in the room, two
     * of the three had their kills refused and watched the enemy stay up.
     *
     * Holding a bound copy is the honest test, and it scales to any number of members.
     */
    static holdsBoundCopyOfCanonical(client: Client, canonicalEntity: any, localEntityId: number): boolean {
        if (!EntityHandler.isServerAuthorityHostileEntity(client.currentLevel, canonicalEntity)) {
            return false;
        }
        if (EntityHandler.getRegisteredHostileLocalIdForViewer(client, canonicalEntity) > 0) {
            return true;
        }

        const canonicalId = Math.max(0, Math.round(Number(canonicalEntity?.id ?? 0)));
        const localId = Math.max(0, Math.round(Number(localEntityId) || 0));
        if (canonicalId > 0 && localId > 0 && EntityHandler.resolveEntityAlias(client, localId) === canonicalId) {
            return true;
        }
        return EntityHandler.isServerAuthorityProxyOwner(client, canonicalEntity, localEntityId);
    }
    static isServerAuthorityProxyOwner(client: Client, canonicalEntity: any, localEntityId: number): boolean {
        if (!EntityHandler.isServerAuthorityHostileEntity(client.currentLevel, canonicalEntity)) {
            return false;
        }

        return EntityHandler.ensureServerAuthorityProxyOwner(client, canonicalEntity, localEntityId);
    }

    private static sendTombstoneDeathCorrectionOnRejoin(
        client: Client,
        entity: any,
        rawLocalId: number,
        tombstone: DeadHostileTombstone
    ): void {
        const localId = Math.max(0, Math.round(Number(rawLocalId || entity?.id) || 0));
        if (localId <= 0) {
            return;
        }

        const scope = getClientLevelScope(client);
        const maxHp = Math.max(
            1,
            Math.round(Number(entity?.maxHp ?? 0)) ||
                EntityHandler.estimateServerAuthorityHostileMaxHp(entity, scope) ||
                1
        );
        client.entities.set(localId, {
            ...entity,
            id: localId,
            hp: 0,
            maxHp,
            healthDelta: -maxHp,
            health_delta: -maxHp,
            dead: true,
            destroyed: true,
            entState: EntityState.DEAD,
            canonicalEntityId: tombstone.canonicalId,
            sharedCanonicalId: tombstone.canonicalId
        });
        client.knownEntityIds.add(localId);
        if (tombstone.canonicalId > 0) {
            client.knownEntityIds.add(tombstone.canonicalId);
        }
        client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -EntityHandler.resolveLethalHostileDelta(getClientLevelScope(client), entity, client.entities.get(localId))));
        client.send(0x07, EntityHandler.buildEntityStateDeadPayload(localId));
        client.send(0x0D, EntityHandler.buildDestroyEntityPayload(localId));
        EntityHandler.retireClientLocalEntity(client, localId, 'rejoin_tombstone');
        client.entities.delete(localId);
        client.knownEntityIds.delete(localId);
    }

    private static attachServerAuthorityClientHostileProxy(
        client: Client,
        levelName: string | null | undefined,
        levelMap: Map<number, any> | null,
        entity: any,
        rawEntityId: number
    ): boolean {
        if (
            !EntityHandler.usesServerAuthorityHostiles(levelName) ||
            !entity ||
            entity.isPlayer ||
            Number(entity.team ?? 0) !== EntityTeam.ENEMY
        ) {
            return false;
        }

        const levelScope = getClientLevelScope(client);
        entity.spawnKey = entity.spawnKey || EntityHandler.getHostileSpawnKey(levelScope, entity);
        const tombstone = EntityHandler.findDeadServerAuthorityHostileTombstone(levelScope, entity);
        if (tombstone) {
            TutorialDungeonMechanics.noteBossHealth(client, {
                ...entity,
                id: tombstone.canonicalId,
                hp: 0,
                dead: true,
                destroyed: true,
                deathVersion: tombstone.deathVersion,
                deathFinalizedAt: tombstone.deathFinalizedAt
            });
            EntityHandler.sendTutorialDungeonWorldSnapshot(client, 'boss_tombstone_attach');
            const localId = Math.max(0, Math.round(Number(rawEntityId || entity.id) || 0));
            if (localId > 0 && tombstone.canonicalId > 0 && localId !== tombstone.canonicalId) {
                EntityHandler.rememberEntityAlias(client, localId, tombstone.canonicalId);
            }
            EntityHandler.sendTombstoneDeathCorrectionOnRejoin(client, entity, localId, tombstone);
            return true;
        }

        if (EntityHandler.isDestroyedServerAuthorityHostileProxy(client, entity)) {
            EntityHandler.destroyDeadServerAuthorityLocalProxy(client, entity, rawEntityId);
            return true;
        }

        const existingCanonical = EntityHandler.findServerAuthorityProxyCanonical(levelName, levelMap, entity);
        const canonical = existingCanonical ??
            EntityHandler.promoteFirstSightServerAuthorityHostile(client, levelName, levelMap, entity, rawEntityId);
        if (!canonical) {
            return false;
        }

        EntityHandler.normalizeServerAuthorityHostileState(levelName, canonical);
        if (TutorialDungeonMechanics.isCompletionBoss(levelName, canonical)) {
            TutorialDungeonMechanics.noteBossHealth(client, canonical);
            EntityHandler.sendTutorialDungeonWorldSnapshot(client, 'boss_proxy_attach');
        }
        const canonicalId = Math.max(0, Math.round(Number(canonical.id ?? 0)));
        const localId = Math.max(0, Math.round(Number(rawEntityId || entity.id) || 0));
        if (canonicalId <= 0 || localId <= 0) {
            return false;
        }

        const existingLocalId = EntityHandler.findExistingServerAuthorityProxyLocalId(client, canonicalId, localId);
        if (existingLocalId > 0) {
            EntityHandler.destroyClientLocalEntity(client, localId, 'proxy_duplicate_destroy', entity);
            return true;
        }

        const isDead = Boolean(canonical.dead) || Number(canonical.entState ?? EntityState.ACTIVE) === EntityState.DEAD;
        // The last unlit fork in the joiner chain.
        //
        // A joiner's client plays every cue in the room, so each of its hostiles arrives here
        // once. `dead=` is the whole question: dead means the run already buried this enemy and
        // the copy is about to be killed on arrival, alive means the copy is legitimately part
        // of the fight. A run reported a joiner killing enemies the party had buried -- with
        // the copy bound to the right canonical and reporting the full pool -- and that can only
        // be one of two things: it attached while the canonical was still alive and the later
        // death never reached them, or it attached to a dead one and this branch did not fire.
        // The line says which, and nothing else in the chain can.
        console.log(
            `[HostileAttach] ${LevelConfig.normalizeLevelName(levelName)} ` +
            `canonical=${canonicalId} name=${String(canonical.name ?? '?')} ` +
            `-> ${String(client.character?.name ?? '?')}:${localId} ` +
            `dead=${isDead} canonicalHp=${Math.round(Number(canonical.hp ?? 0))}/${Math.round(Number(canonical.maxHp ?? 0))} ` +
            `matched=${existingCanonical ? 'roster' : 'promoted'}`
        );
        EntityHandler.ensureServerAuthorityProxyOwner(client, canonical, localId);
        EntityHandler.registerCanonicalHostileAlias(
            client,
            getClientLevelScope(client),
            canonical,
            localId,
            localId === canonicalId ? 'server_authority_same_id_attach' : 'server_authority_proxy_attach'
        );
        if (!EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelName)) {
            if (localId !== canonicalId) {
                EntityHandler.rememberEntityAlias(client, localId, canonicalId);
            }
            client.knownEntityIds.add(canonicalId);
            client.knownEntityIds.add(localId);

            const proxyEntity = {
                ...entity,
                id: localId,
                level: EntityHandler.resolveServerAuthorityEntityLevel(levelName),
                hp: Math.max(0, Math.round(Number(canonical.hp ?? 0))),
                maxHp: Math.max(0, Math.round(Number(canonical.maxHp ?? 0))),
                healthDelta: Math.round(Number(canonical.healthDelta ?? 0)),
                health_delta: Math.round(Number(canonical.health_delta ?? canonical.healthDelta ?? 0)),
                dead: isDead,
                entState: isDead ? EntityState.DEAD : Number(entity.entState ?? canonical.entState ?? EntityState.ACTIVE),
                canonicalEntityId: canonicalId,
                sharedCanonicalId: canonicalId,
                clientSpawned: true,
                ownerToken: client.token,
                ownerUserId: client.userId ?? 0,
                ownerCharacterName: client.character?.name ?? '',
                ownerPartyId: getPartyIdForClient(client)
            };
            client.entities.set(localId, proxyEntity);

            if (isDead) {
                const maxHp = Math.max(0, Math.round(Number(canonical.maxHp ?? 0)));
                if (maxHp > 0) {
                    client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -EntityHandler.resolveLethalHostileDelta(getClientLevelScope(client), canonical ?? entity ?? null, client.entities.get(localId))));
                }
                client.send(0x07, EntityHandler.buildEntityStateDeadPayload(localId));
                client.send(0x0D, EntityHandler.buildDestroyEntityPayload(localId));
                EntityHandler.retireClientLocalEntity(client, localId, 'proxy_attach_dead');
                client.entities.delete(localId);
            } else {
                EntityHandler.sendServerAuthorityProxyInitialHpSync(client, canonical, localId, 'proxy_attach');
            }

            return true;
        }
        if (EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelName)) {
            EntityHandler.bridgeCanonicalVisibleServerAuthorityProxy(
                client,
                levelName,
                canonical,
                entity,
                localId,
                isDead,
                isDead ? 'proxy_bridge_attach_dead' : 'proxy_bridge_attach_live'
            );
            return true;
        }
        EntityHandler.replaceClientHostileProxyWithCanonical(
            client,
            levelName,
            canonical,
            localId,
            isDead ? 'proxy_attach_dead' : 'proxy_attach_live',
            entity
        );

        if (isDead) {
            const maxHp = Math.max(0, Math.round(Number(canonical.maxHp ?? 0)));
            if (maxHp > 0) {
                client.send(0x78, EntityHandler.buildHpDeltaPayload(canonicalId, -EntityHandler.resolveLethalHostileDelta(getClientLevelScope(client), canonical ?? entity ?? null, client.entities.get(localId))));
            }
            client.send(0x07, EntityHandler.buildEntityStateDeadPayload(canonicalId));
            client.send(0x0D, EntityHandler.buildDestroyEntityPayload(canonicalId));
            // This path addresses the enemy by its canonical id, because
            // replaceClientHostileProxyWithCanonical has just re-pointed the client's copy onto
            // it. Retire both ids: the local one is what the client spawned and may still be
            // holding, and only one of the two will resolve to a body.
            EntityHandler.retireClientLocalEntity(client, canonicalId, 'proxy_replaced_dead');
            if (localId > 0 && localId !== canonicalId) {
                EntityHandler.retireClientLocalEntity(client, localId, 'proxy_replaced_dead_local');
            }
            client.entities.delete(canonicalId);
            client.knownEntityIds.delete(canonicalId);
        }

        return true;
    }

    private static replaceClientHostileProxyWithCanonical(
        client: Client,
        levelName: string | null | undefined,
        canonical: any,
        rawLocalEntityId: number,
        reason: string,
        rawLocalEntity: any = null
    ): void {
        if (!EntityHandler.isServerAuthorityHostileEntity(levelName, canonical)) {
            return;
        }

        EntityHandler.normalizeServerAuthorityHostileState(levelName, canonical);
        const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? 0)));
        const localId = Math.max(0, Math.round(Number(rawLocalEntityId) || 0));
        if (canonicalId <= 0) {
            return;
        }

        const existingCanonical = client.entities.get(canonicalId);
        const hasServerCanonical =
            Boolean(existingCanonical) &&
            !Boolean(existingCanonical?.clientSpawned) &&
            client.knownEntityIds.has(canonicalId);

        if (localId > 0 && (localId !== canonicalId || !hasServerCanonical)) {
            EntityHandler.destroyClientLocalEntity(client, localId, reason, rawLocalEntity);
        }
        if (localId > 0 && localId !== canonicalId) {
            EntityHandler.rememberEntityAlias(client, localId, canonicalId);
        }

        const snapshot = {
            ...canonical,
            id: canonicalId,
            clientSpawned: false,
            canonicalEntityId: undefined,
            sharedCanonicalId: undefined,
            ownerToken: 0,
            ownerUserId: 0,
            ownerPartyId: 0,
            ownerCharacterName: ''
        };
        client.entities.delete(localId);
        client.knownEntityIds.delete(localId);
        client.entities.set(canonicalId, { ...snapshot });
        client.knownEntityIds.add(canonicalId);
        EntityHandler.setSharedEntityRemoteUpdatesDeferred(client, canonicalId, false);
        const needsCanonicalSpawn = !hasServerCanonical || localId === canonicalId;
        if (needsCanonicalSpawn) {
            EntityHandler.sendEntity(client, snapshot);
            if (Boolean(snapshot.untargetable)) {
                EntityHandler.sendSetUntargetable(client, canonicalId, true);
            }
        }
    }

    private static bridgeCanonicalVisibleServerAuthorityProxy(
        client: Client,
        levelName: string | null | undefined,
        canonical: any,
        rawLocalEntity: any,
        rawLocalEntityId: number,
        isDead: boolean,
        reason: string
    ): void {
        if (!EntityHandler.isServerAuthorityHostileEntity(levelName, canonical)) {
            return;
        }

        EntityHandler.normalizeServerAuthorityHostileState(levelName, canonical);
        const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? 0)));
        const localId = Math.max(0, Math.round(Number(rawLocalEntityId) || 0));
        if (canonicalId <= 0 || localId <= 0) {
            return;
        }

        const localEntity = rawLocalEntity && typeof rawLocalEntity === 'object'
            ? rawLocalEntity
            : client.entities.get(localId) ?? canonical;
        if (localId !== canonicalId) {
            EntityHandler.rememberEntityAlias(client, localId, canonicalId);
        }
        client.knownEntityIds.add(localId);
        client.knownEntityIds.add(canonicalId);
        EntityHandler.setSharedEntityRemoteUpdatesDeferred(client, canonicalId, false);
        EntityHandler.syncCanonicalVisibleServerAuthorityHostileFromProxy(client, canonical, localEntity, localId);

        const maxHp = Math.max(0, Math.round(Number(canonical.maxHp ?? 0)));
        const hp = Math.max(0, Math.round(Number(canonical.hp ?? 0)));
        const healthDelta = hp - maxHp;
        const bridgedEntity = {
            ...localEntity,
            id: localId,
            level: EntityHandler.resolveServerAuthorityEntityLevel(levelName),
            hp,
            maxHp,
            healthDelta,
            health_delta: healthDelta,
            dead: isDead,
            entState: isDead ? EntityState.DEAD : Number(localEntity?.entState ?? canonical.entState ?? EntityState.ACTIVE),
            canonicalEntityId: canonicalId,
            sharedCanonicalId: canonicalId,
            clientSpawned: true,
            ownerToken: client.token,
            ownerUserId: client.userId ?? 0,
            ownerCharacterName: client.character?.name ?? '',
            ownerPartyId: getPartyIdForClient(client)
        };
        client.entities.set(localId, bridgedEntity);

        if (isDead) {
            if (maxHp > 0) {
                client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -EntityHandler.resolveLethalHostileDelta(getClientLevelScope(client), canonical, client.entities.get(localId))));
            }
            client.send(0x07, EntityHandler.buildEntityStateDeadPayload(localId));
            client.send(0x0D, EntityHandler.buildDestroyEntityPayload(localId));
            // This copy is being bound to an enemy that was already dead when it arrived, which
            // in practice means a member walking into a dungeon their party has been clearing
            // without them. The burial above makes their client count the kill; without the
            // retire they would then watch it die and lie there for ten seconds, for a kill
            // somebody else made before they were in the level.
            EntityHandler.retireClientLocalEntity(client, localId, 'attached_to_dead_canonical');
            client.entities.delete(localId);
            client.knownEntityIds.delete(localId);
            return;
        }

        EntityHandler.sendServerAuthorityProxyInitialHpSync(client, canonical, localId, reason);
        if (Boolean(canonical.untargetable)) {
            EntityHandler.sendSetUntargetable(client, localId, true);
        }
    }

    private static isDestroyedServerAuthorityHostileProxy(client: Client, entity: any): boolean {
        const levelScope = getClientLevelScope(client);
        if (!levelScope) {
            return false;
        }

        const fingerprint = EntityHandler.getServerAuthorityHostileFingerprint(entity);
        return Boolean(
            fingerprint &&
            EntityHandler.serverAuthorityDestroyedFingerprintsByScope.get(levelScope)?.has(fingerprint)
        );
    }

    private static destroyDeadServerAuthorityLocalProxy(client: Client, entity: any, rawEntityId: number): void {
        const localId = Math.max(0, Math.round(Number(rawEntityId || entity?.id) || 0));
        if (localId <= 0) {
            return;
        }

        const deadSnapshot = {
            ...entity,
            id: localId,
            clientSpawned: true,
            ownerToken: client.token,
            ownerUserId: client.userId ?? 0,
            ownerCharacterName: client.character?.name ?? '',
            ownerPartyId: getPartyIdForClient(client),
            dead: true,
            entState: EntityState.DEAD
        };
        EntityHandler.normalizeServerAuthorityHostileState(client.currentLevel, deadSnapshot);
        const maxHp = Math.max(0, Math.round(Number(deadSnapshot.maxHp ?? deadSnapshot.hp ?? 0)));
        client.entities.set(localId, deadSnapshot);
        client.knownEntityIds.add(localId);
        if (maxHp > 0) {
            client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -EntityHandler.resolveLethalHostileDelta(getClientLevelScope(client), deadSnapshot, client.entities.get(localId))));
        }
        client.send(0x07, EntityHandler.buildEntityStateDeadPayload(localId));
        client.send(0x0D, EntityHandler.buildDestroyEntityPayload(localId));
        // The client just played this room's cues and spawned a copy of an enemy the run had
        // already destroyed. It should never have been drawn at all, so it is retired outright
        // rather than left as a corpse the arriving player has to walk past.
        EntityHandler.retireClientLocalEntity(client, localId, 'destroyed_before_this_client_arrived');
        client.entities.delete(localId);
        client.knownEntityIds.delete(localId);
    }

    private static promoteFirstSightServerAuthorityHostile(
        client: Client,
        levelName: string | null | undefined,
        levelMap: Map<number, any> | null,
        entity: any,
        rawEntityId: number
    ): any | null {
        const normalizedLevelName = LevelConfig.normalizeLevelName(levelName);
        if (
            !normalizedLevelName ||
            !EntityHandler.FIRST_SIGHT_SERVER_AUTHORITY_HOSTILE_LEVELS.has(normalizedLevelName) ||
            !levelMap ||
            !entity ||
            entity.isPlayer ||
            Number(entity.team ?? 0) !== EntityTeam.ENEMY
        ) {
            return null;
        }

        const canonicalId = Math.max(0, Math.round(Number(rawEntityId || entity.id) || 0));
        if (canonicalId <= 0) {
            return null;
        }

        const existing = levelMap.get(canonicalId);
        if (existing && !existing.isPlayer) {
            return existing;
        }

        const canonical = {
            ...entity,
            id: canonicalId,
            clientSpawned: false,
            ownerToken: 0,
            ownerUserId: 0,
            ownerPartyId: 0,
            ownerCharacterName: '',
            canonicalEntityId: undefined,
            sharedCanonicalId: undefined,
            proxyOwnerToken: client.token,
            proxyOwnerName: client.character?.name ?? '',
            proxyOwnerLocalId: canonicalId
        };
        EntityHandler.normalizeServerAuthorityHostileState(normalizedLevelName, canonical);
        levelMap.set(canonicalId, canonical);
        EntityHandler.fanOutCanonicalVisibleServerAuthorityHostile(client, normalizedLevelName, canonical);
        return canonical;
    }

    // A dungeon scope key is `levelName#levelInstanceId`, and for a solo run the
    // instance id is just the session token — so re-entering the same dungeon in
    // one session lands on the identical scope. Both the entity map and the
    // completion state are only built when the scope is new (see the `!levelMap`
    // guard in sendInitialLevelEntities), so a second run inherited the first
    // run's dead bosses: defeatedBosses still held the boss, objectivesMet was
    // already true on entry, and the rank plate fired before the boss had even
    // spawned. resetServerAuthorityScopeForFreshRun does clear all of this, but
    // it bails out on its first line for anything outside SERVER_AUTHORITY_
    // HOSTILE_LEVELS — i.e. for every ordinary dungeon.
    private static resetFinishedDungeonRunScope(client: Client, levelName: string): void {
        if (!LevelConfig.isDungeonLevel(levelName)) {
            return;
        }

        const levelScope = getLevelScopeKey(levelName, client.levelInstanceId);
        if (!levelScope) {
            return;
        }

        // A joiner must never wipe a run its party is still playing.
        if (EntityHandler.hasOtherActiveSessionInScope(client, levelScope)) {
            return;
        }

        const levelMap = EntityHandler.getLevelMap(levelName, client.levelInstanceId);
        if (!levelMap) {
            return;
        }

        // Drop the whole scope rather than just its hostiles. Clearing the state
        // alone is not enough: recoverDefeatedObjectivesFromScope re-derives
        // defeatedBosses from whatever defeated entities are still sitting in the
        // scope, so the reset would be undone on the very next evaluate(). And
        // emptying the map in place is not enough either — sendInitialLevelEntities
        // only seeds NPCs when the map is absent (`!levelMap`), so an emptied but
        // present map would leave the new run with no enemies at all.
        GlobalState.levelEntities.delete(levelScope);
        GlobalState.levelQuestProgress.delete(levelScope);
        DungeonCompletionSystem.reset(levelScope);
        // A fresh run must not inherit the previous run's open boss scene, or the
        // first legitimate boss cue of the new run would be read as a copy.
        clearOpenBossScene(levelScope);
        // Same reasoning for the boss pool: a new run gets full health bars and a
        // fresh damage ledger, not the corpse the last run left behind.
        clearBossAuthority(levelScope);
        console.log(
            `[EntityHandler] Cleared finished dungeon run scope ${levelScope} ` +
            `(${levelMap.size} stale entities) for a fresh run`
        );
    }

    private static resetServerAuthorityScopeForFreshRun(client: Client, levelName: string, levelMap: Map<number, any>): void {
        if (!EntityHandler.usesServerAuthorityHostiles(levelName)) {
            return;
        }

        const levelScope = getLevelScopeKey(levelName, client.levelInstanceId);
        if (!levelScope || EntityHandler.hasOtherActiveSessionInScope(client, levelScope)) {
            return;
        }

        // A fresh run redraws from scratch, so it must not inherit a spent retry budget.
        EntityHandler.forgetDrawnHostileRetries(levelScope);

        if (
            String(client.levelInstanceId ?? '').trim() &&
            Array.from(levelMap.values()).some((entity) => EntityHandler.isServerAuthorityHostileEntity(levelName, entity))
        ) {
            return;
        }

        if (EntityHandler.clientKnowsServerAuthorityHostile(client, levelMap)) {
            return;
        }

        let removed = 0;
        for (const [entityId, entity] of Array.from(levelMap.entries())) {
            if (!entity?.isPlayer && Number(entity?.team ?? 0) === EntityTeam.ENEMY) {
                levelMap.delete(entityId);
                removed++;
            }
        }

        EntityHandler.serverAuthoritySeededScopes.delete(levelScope);
        // A fresh run sizes itself from its own party, so the latched difficulty goes with it.
        EntityHandler.forgetServerAuthorityScopeLevel(levelScope);
        EntityHandler.serverAuthorityDestroyedIdsByScope.delete(levelScope);
        EntityHandler.serverAuthorityDestroyedFingerprintsByScope.delete(levelScope);
        EntityHandler.clearDeadServerAuthorityHostileTombstones(levelScope, 'new_run');
        GlobalState.levelQuestProgress.delete(levelScope);
        DungeonCompletionSystem.reset(levelScope);
        TutorialDungeonMechanics.resetState(levelScope);
        const keyPrefix = `${levelScope}:`;
        for (const key of Array.from(GlobalState.combatContributions.keys())) {
            if (key.startsWith(keyPrefix)) {
                GlobalState.combatContributions.delete(key);
            }
        }
        for (const key of Array.from(GlobalState.entityLifeNonces.keys())) {
            if (key.startsWith(keyPrefix)) {
                GlobalState.entityLifeNonces.delete(key);
            }
        }
        for (const key of Array.from(GlobalState.entityLastRewardNonces.keys())) {
            if (key.startsWith(keyPrefix)) {
                GlobalState.entityLastRewardNonces.delete(key);
            }
        }
    }

    static suppressServerAuthorityClientHostileSpawn(
        client: Client,
        levelName: string | null | undefined,
        entity: any,
        rawEntityId: number,
        reason: string = 'client_hostile_spawn'
    ): boolean {
        if (levelName) {
            EntityHandler.ensureJcMini1PartySharedScope(client, levelName, reason);
        }
        const levelMap = levelName ? EntityHandler.getLevelMapForClient(client, true) : null;
        if (levelName && levelMap && EntityHandler.usesServerAuthorityHostiles(levelName)) {
            EntityHandler.seedServerAuthorityHostiles(client, levelName, levelMap);
        }
        return EntityHandler.attachServerAuthorityClientHostileProxy(client, levelName, levelMap, entity, rawEntityId);
    }

    static destroyClientLocalEntity(
        client: Client,
        rawEntityId: number,
        reason: string,
        entity: any = null
    ): void {
        const localId = Math.max(0, Math.round(Number(rawEntityId) || 0));
        if (localId <= 0) {
            return;
        }

        const localCopy = client.entities.get(localId) ?? entity;
        client.entities.delete(localId);
        client.knownEntityIds.delete(localId);
        client.drawnPlayerRoomIds?.delete(localId);
        client.entityIdAliases?.delete(localId);
        // Lethal damage first, then the dead state and the destroy.
        //
        // This is the path that takes away a client's *own* copy of a hostile when it could not
        // be bound to the canonical one -- a refused duplicate, an unbindable spawn -- and in
        // The East Wing every client spawns such copies
        // ([[east-wing-is-both-client-spawn-and-server-authority]]). Both packets it used to
        // send are dropped by the client for an entity with no class_122 record, which is
        // exactly what a self-spawned hostile is. So this function removed the copy from the
        // SERVER and left it standing at full health on the screen; the comment that used to
        // sit here claimed the dead state retired it, and it never did.
        //
        // That is the enemy that "respawns" for a joiner. Their client plays the room's cues,
        // the server refuses every copy it cannot bind, and each refusal leaves a live enemy
        // the server has no record of -- which the player then fights and kills, producing an
        // [EnemyDeath] for a canonical the run had buried before they arrived.
        //
        // 0x78 has no such gate: its reader calls TakeDamage, so a lethal negative delta makes
        // the client kill its own copy through its own death path, with the room bookkeeping
        // its dungeon percentage is computed from.
        const lethalHp = Math.max(
            1,
            Math.round(Number(
                localCopy?.maxHp ??
                localCopy?.hp ??
                EntityHandler.estimateServerAuthorityHostileMaxHp(localCopy, getClientLevelScope(client))
            )) || 1
        );
        client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -lethalHp));
        client.send(0x07, EntityHandler.buildEntityStateDeadPayload(localId));
        client.send(0x0D, EntityHandler.buildDestroyEntityPayload(localId));
    }

    static sendTutorialDungeonWorldSnapshot(client: Client, reason: string): boolean {
        if (!TutorialDungeonMechanics.isTutorialDungeon(client.currentLevel)) {
            return false;
        }
        const levelScope = getClientLevelScope(client);
        const wireRoomId = Math.max(0, Math.round(Number(client.currentRoomId ?? 0)));
        const snapshot = TutorialDungeonMechanics.serializeSnapshot(levelScope);
        if (!levelScope || wireRoomId <= 0 || !snapshot) {
            return false;
        }
        const bb = new BitBuffer(false);
        bb.writeMethod26(`${wireRoomId}^GoblinKidnappersAuthority^ApplySnapshot`);
        bb.writeMethod26(snapshot);
        client.sendBitBuffer(0x40, bb);
        return true;
    }

    static applyTutorialDungeonWorldSnapshotToLocalObject(
        client: Client,
        entity: any,
        rawEntityId: number
    ): boolean {
        if (!TutorialDungeonMechanics.isTutorialDungeon(client.currentLevel) || !entity || entity.isPlayer) {
            return false;
        }
        const authority = TutorialDungeonMechanics.tagClientObject(entity, Number(client.currentRoomId ?? 0));
        if (!authority || authority.role === 'boss' || authority.role === 'anna') {
            return false;
        }
        const levelScope = getClientLevelScope(client);
        EntityHandler.sendTutorialDungeonWorldSnapshot(client, 'room_object_ready');
        if (!TutorialDungeonMechanics.isWorldObjectResolved(levelScope, authority.stableId)) {
            return false;
        }

        const localId = Math.max(0, Math.round(Number(rawEntityId || entity.id) || 0));
        if (localId <= 0) {
            return false;
        }
        entity.dead = true;
        entity.destroyed = true;
        entity.hp = 0;
        entity.entState = EntityState.DEAD;
        client.send(0x07, EntityHandler.buildEntityStateDeadPayload(localId));
        client.send(0x0D, EntityHandler.buildDestroyEntityPayload(localId));
        client.entities.delete(localId);
        client.knownEntityIds.delete(localId);
        TutorialDungeonMechanics.logSnapshotApplied(client, authority.stableId, 1, false);
        return true;
    }

    static broadcastTutorialDungeonObjectTransition(
        sourceClient: Client,
        authority: TutorialDungeonAuthorityEntity
    ): number {
        const levelScope = getClientLevelScope(sourceClient);
        const state = TutorialDungeonMechanics.getClientState(sourceClient);
        if (!levelScope || !state) {
            return 0;
        }

        let recipients = 0;
        for (const viewer of GlobalState.getSessionsInLevelScope(levelScope)) {
            if (!viewer.playerSpawned || getClientLevelScope(viewer) !== levelScope) {
                continue;
            }
            EntityHandler.sendTutorialDungeonWorldSnapshot(viewer, 'world_transition');
            const localEntity = TutorialDungeonMechanics.findClientLocalObject(viewer, authority.stableId);
            const localId = Math.max(0, Math.round(Number(localEntity?.id ?? 0)));
            if (localId <= 0) {
                continue;
            }
            localEntity.dead = true;
            localEntity.destroyed = true;
            localEntity.hp = 0;
            localEntity.entState = EntityState.DEAD;
            viewer.send(0x07, EntityHandler.buildEntityStateDeadPayload(localId));
            viewer.send(0x0D, EntityHandler.buildDestroyEntityPayload(localId));
            viewer.entities.delete(localId);
            viewer.knownEntityIds.delete(localId);
            recipients++;
        }
        const objectState = state.objects.get(authority.stableId);
        TutorialDungeonMechanics.logTransition(
            state,
            authority,
            'active',
            objectState?.lifecycle ?? 'destroyed',
            sourceClient.token,
            recipients,
            false,
            'broadcast'
        );
        return recipients;
    }

    private static usesLeaderAuthoritativeClientSpawns(levelName: string | null | undefined): boolean {
        // Hybrid dungeon authority: while Flash still runs temporary enemy AI,
        // server-owned DungeonInstance state chooses one canonical client-spawn
        // actor and aliases follower duplicates to it. TODO: replace this bridge
        // with full server-side enemy spawning and AI.
        return LevelConfig.isDungeonLevel(levelName);
    }

    private static shouldSkipDungeonRoomProgressSync(levelName: string | null | undefined): boolean {
        return Boolean(levelName) && EntityHandler.GOBLIN_RIVER_ROOM_SYNC_SKIP_LEVELS.has(String(levelName));
    }

    private static isEntityDead(entity: any): boolean {
        return Boolean(entity?.dead) ||
            Boolean(entity?.destroyed) ||
            Number(entity?.entState ?? EntityState.ACTIVE) === EntityState.DEAD ||
            Math.round(Number(entity?.hp ?? 1)) <= 0;
    }

    private static getHostileAliasMap(entity: any): Map<number, number> {
        if (!entity || typeof entity !== 'object') {
            return new Map<number, number>();
        }

        if (entity.localIdsByToken instanceof Map) {
            return entity.localIdsByToken;
        }

        const map = new Map<number, number>();
        const raw = entity.localIdsByToken;
        if (raw && typeof raw === 'object') {
            for (const [tokenValue, localIdValue] of Object.entries(raw)) {
                const token = Math.max(0, Math.round(Number(tokenValue) || 0));
                const localId = Math.max(0, Math.round(Number(localIdValue) || 0));
                if (token > 0 && localId > 0) {
                    map.set(token, localId);
                }
            }
        }
        entity.localIdsByToken = map;
        return map;
    }

    static getHostileSpawnKey(levelScope: string, entity: any): string {
        const roomId = Number.isFinite(Number(entity?.roomId)) ? Math.round(Number(entity.roomId)) : -1;
        const entName = EntityHandler.normalizeIdentityName(
            entity?.entType ??
            entity?.EntType ??
            entity?.name ??
            entity?.EntName ??
            entity?.characterName ??
            entity?.character_name
        );
        const spawnIndex = Math.max(
            -1,
            Math.round(Number(
                entity?.spawnIndex ??
                entity?.spawn_index ??
                entity?.spawnId ??
                entity?.spawn_id ??
                entity?.SpawnIndex ??
                -1
            ) || -1)
        );
        const rawX = Number(entity?.x ?? entity?.physPosX ?? 0);
        const rawY = Number(entity?.y ?? entity?.physPosY ?? 0);
        const bucketX = Number.isFinite(rawX) ? Math.round(rawX / 25) * 25 : 0;
        const bucketY = Number.isFinite(rawY) ? Math.round(rawY / 25) * 25 : 0;
        return [
            levelScope,
            `room:${roomId}`,
            `type:${entName}`,
            spawnIndex >= 0 ? `spawn:${spawnIndex}` : `pos:${bucketX}:${bucketY}`
        ].join('|');
    }

    private static normalizeCanonicalHostileAliasRegistry(
        levelScope: string,
        canonical: any,
        canonicalId: number,
        localId: number,
        client: Client
    ): void {
        if (!canonical || typeof canonical !== 'object' || canonicalId <= 0 || localId <= 0) {
            return;
        }

        canonical.canonicalId = canonicalId;
        canonical.levelScope = levelScope;
        canonical.spawnKey = canonical.spawnKey || EntityHandler.getHostileSpawnKey(levelScope, canonical);
        canonical.entType = canonical.entType ?? canonical.EntType ?? canonical.name ?? canonical.EntName ?? '';
        canonical.ownerToken = Math.max(0, Math.round(Number(canonical.ownerToken ?? client.token ?? 0)));
        canonical.aiOwnerToken = Math.max(0, Math.round(Number(canonical.aiOwnerToken ?? canonical.ownerToken ?? client.token ?? 0)));
        canonical.ownerPartyId = Math.max(0, Math.round(Number(canonical.ownerPartyId ?? getPartyIdForClient(client) ?? 0)));
        if (!Number.isFinite(Number(canonical.roomId))) {
            canonical.roomId = client.currentRoomId;
        }
        EntityHandler.getHostileAliasMap(canonical).set(client.token, localId);
    }

    static registerCanonicalHostileAlias(
        client: Client,
        levelScope: string,
        canonical: any,
        localEntityId: number,
        reason: string
    ): void {
        const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? canonical?.canonicalId ?? 0)));
        const localId = Math.max(0, Math.round(Number(localEntityId) || 0));
        if (!levelScope || !canonical || canonicalId <= 0 || localId <= 0) {
            return;
        }

        EntityHandler.normalizeCanonicalHostileAliasRegistry(levelScope, canonical, canonicalId, localId, client);
        if (localId !== canonicalId) {
            EntityHandler.rememberEntityAlias(client, localId, canonicalId);
        }
        client.knownEntityIds.add(localId);
        client.knownEntityIds.add(canonicalId);
    }

    static resolveHostileLocalIdForViewer(
        viewer: Client,
        levelScope: string,
        canonicalId: number,
        packetLabel: string = ''
    ): { ok: boolean; localId: number; entity: any | null; reason: string } {
        const entityId = Math.max(0, Math.round(Number(canonicalId) || 0));
        if (!levelScope || entityId <= 0) {
            return { ok: true, localId: entityId, entity: null, reason: 'invalid_or_noncanonical' };
        }

        const canonical = GlobalState.levelEntities.get(levelScope)?.get(entityId) ?? null;
        if (
            !canonical ||
            Boolean(canonical.isPlayer) ||
            Number(canonical.team ?? 0) !== EntityTeam.ENEMY ||
            (
                !EntityHandler.isSharedClientSpawnRegionActor(getScopeLevelName(levelScope), canonical) &&
                !EntityHandler.isServerAuthorityHostileEntity(getScopeLevelName(levelScope), canonical)
            )
        ) {
            return { ok: true, localId: EntityHandler.resolveEntityLocalId(viewer, entityId), entity: canonical, reason: 'not_hostile_canonical' };
        }

        const aliasMap = EntityHandler.getHostileAliasMap(canonical);
        const registeredLocalId = Math.max(0, Math.round(Number(aliasMap.get(viewer.token)) || 0));
        if (registeredLocalId > 0) {
            if (registeredLocalId !== entityId || viewer.entities.has(registeredLocalId) || viewer.knownEntityIds.has(registeredLocalId)) {
                return { ok: true, localId: registeredLocalId, entity: canonical, reason: 'registered' };
            }
        }

        const legacyLocalId = EntityHandler.resolveEntityLocalId(viewer, entityId);
        if (
            legacyLocalId > 0 &&
            legacyLocalId !== entityId &&
            (viewer.entities.has(legacyLocalId) || viewer.knownEntityIds.has(legacyLocalId))
        ) {
            EntityHandler.registerCanonicalHostileAlias(viewer, levelScope, canonical, legacyLocalId, 'legacy_alias_backfill');
            return { ok: true, localId: legacyLocalId, entity: canonical, reason: 'legacy_alias_backfill' };
        }

        const ownsCanonical = Math.max(0, Math.round(Number(canonical.ownerToken ?? canonical.aiOwnerToken ?? 0))) === viewer.token ||
            Math.max(0, Math.round(Number(canonical.aiOwnerToken ?? canonical.ownerToken ?? 0))) === viewer.token;
        if (
            ownsCanonical &&
            (viewer.entities.has(entityId) || viewer.knownEntityIds.has(entityId) || registeredLocalId === entityId)
        ) {
            EntityHandler.registerCanonicalHostileAlias(viewer, levelScope, canonical, entityId, 'owner_canonical_visible');
            return { ok: true, localId: entityId, entity: canonical, reason: 'owner_canonical_visible' };
        }
        return { ok: false, localId: 0, entity: canonical, reason: 'missing_viewer_local_id' };
    }

    static getRegisteredHostileLocalIdForViewer(viewer: Client, canonical: any): number {
        if (!canonical || typeof canonical !== 'object') {
            return 0;
        }
        const aliasMap = EntityHandler.getHostileAliasMap(canonical);
        return Math.max(0, Math.round(Number(aliasMap.get(viewer.token)) || 0));
    }

    static isHomeDummyEntity(entity: any): boolean {
        return /^HomeDummy[123]$/.test(String(entity?.name ?? entity?.EntName ?? entity?.entName ?? ''));
    }

    private static shouldDeferLiveSharedHostileSeedToJoiner(joiner: Client, entity: any): boolean {
        return Boolean(joiner.currentLevel) &&
            !EntityHandler.usesServerAuthorityHostiles(joiner.currentLevel) &&
            EntityHandler.isPartySharedClientSpawnHostile(joiner.currentLevel, entity) &&
            !EntityHandler.isEntityDead(entity);
    }

    private static resolveRuntimeDungeonEntityLevel(client: Client, levelName: string | null | undefined, fallbackLevel: number = 1): number {
        if (!LevelConfig.isDungeonLevel(levelName)) {
            return Math.max(1, Math.min(50, Math.round(Number(fallbackLevel) || 1)));
        }

        // Scope, not party: two players in the same dungeon instance must scale
        // its enemies identically even when they are not grouped, or their health
        // bars disagree from the first hit.
        return getScopeRuntimeLevel(getClientLevelScope(client), client, fallbackLevel);
    }

    private static applyRuntimeDungeonEntityLevel(client: Client, levelName: string | null | undefined, entity: any): void {
        if (!entity || entity.isPlayer || !LevelConfig.isDungeonLevel(levelName)) {
            return;
        }

        if (
            EntityHandler.usesServerAuthorityHostiles(levelName) &&
            Number(entity.team ?? 0) === EntityTeam.ENEMY &&
            !Boolean(entity.clientSpawned)
        ) {
            // The client's *scope*, not the bare level name. The run's tier is a property of
            // one instance of the dungeon -- the party standing in it -- and a bare level name
            // matches no session's scope, so it silently fell back to the authored tier and
            // built the hostile at the wrong size.
            EntityHandler.normalizeServerAuthorityHostileState(getClientLevelScope(client) || levelName, entity);
            return;
        }

        entity.level = EntityHandler.resolveRuntimeDungeonEntityLevel(client, levelName, entity.level);
        EntityHandler.adoptBossAuthority(getClientLevelScope(client), entity);
    }

    // Every path that registers a hostile funnels through here, so a boss copy
    // can never enter the run without landing on the scope's existing pool.
    static adoptBossAuthority(levelScope: string | null | undefined, entity: any): void {
        if (Number(entity?.team ?? 0) !== EntityTeam.ENEMY) {
            return;
        }

        const { CombatHandler } = require('./CombatHandler') as typeof import('./CombatHandler');
        noteBossEntity(levelScope, entity, (candidate, scope) =>
            CombatHandler.estimateHostileMaxHpForBossAuthority(candidate, scope)
        );
    }

    static rescaleDungeonEntitiesForParty(client: Client): number {
        const levelName = client.currentLevel;
        if (!levelName || !LevelConfig.isDungeonLevel(levelName)) {
            return 0;
        }

        const runtimeLevel = EntityHandler.resolveRuntimeDungeonEntityLevel(client, levelName, 1);
        const levelScope = getClientLevelScope(client);
        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (!levelMap) {
            return 0;
        }

        let updatedCount = 0;
        for (const [entityId, entity] of levelMap.entries()) {
            if (!entity || entity.isPlayer) {
                continue;
            }

            if (EntityHandler.isServerAuthorityHostileEntity(levelName, entity)) {
                const oldLevel = Math.round(Number(entity.level ?? 0));
                const oldHp = Math.round(Number(entity.hp ?? 0));
                const oldMaxHp = Math.round(Number(entity.maxHp ?? 0));
                EntityHandler.normalizeServerAuthorityHostileState(levelName, entity);
                for (const session of GlobalState.getSessionsInLevelScope(levelScope)) {
                    if (!session.playerSpawned || getClientLevelScope(session) !== levelScope) {
                        continue;
                    }

                    const localEntityId = EntityHandler.resolveEntityLocalId(session, entityId);
                    const localEntity = session.entities.get(localEntityId) ?? session.entities.get(entityId);
                    if (!localEntity || localEntity.isPlayer) {
                        continue;
                    }

                    EntityHandler.normalizeServerAuthorityHostileState(levelName, localEntity);
                }
                if (
                    oldLevel !== Math.round(Number(entity.level ?? 0)) ||
                    oldHp !== Math.round(Number(entity.hp ?? 0)) ||
                    oldMaxHp !== Math.round(Number(entity.maxHp ?? 0))
                ) {
                    updatedCount++;
                }
                continue;
            }

            const currentLevel = Math.max(1, Math.round(Number(entity.level ?? 0) || 1));
            if (currentLevel >= runtimeLevel) {
                continue;
            }

            entity.level = runtimeLevel;
            for (const session of GlobalState.getSessionsInLevelScope(levelScope)) {
                if (!session.playerSpawned || getClientLevelScope(session) !== levelScope) {
                    continue;
                }

                const localEntity = session.entities.get(entityId);
                if (!localEntity || localEntity.isPlayer) {
                    continue;
                }

                localEntity.level = runtimeLevel;
            }
            updatedCount++;
        }

        return updatedCount;
    }

    private static isPrivateClientSpawnOutdoorEntity(levelName: string | null | undefined, entity: any): boolean {
        if (!levelName || !entity?.clientSpawned || entity?.isPlayer) {
            return false;
        }

        if (levelName === 'CraftTownTutorial') {
            return false;
        }

        const team = Number(entity?.team ?? 0);
        return (
            (team === 2 || team === 3) &&
            EntityHandler.usesClientSpawn(levelName) &&
            !LevelConfig.isDungeonLevel(levelName)
        );
    }

    private static isPrivateClientSpawnNpc(levelName: string | null | undefined, entity: any): boolean {
        return (
            EntityHandler.isPrivateClientSpawnOutdoorEntity(levelName, entity) &&
            Number(entity?.team ?? 0) === 3
        );
    }

    private static isSharedClientSpawnRegionActor(levelName: string | null | undefined, entity: any): boolean {
        if (!levelName || entity?.isPlayer) {
            return false;
        }

        if (Boolean(entity?.hybridCanonicalHostile) && Number(entity?.team ?? 0) === EntityTeam.ENEMY) {
            return LevelConfig.isDungeonLevel(levelName);
        }

        if (!entity?.clientSpawned) {
            return false;
        }

        if (EntityHandler.isPrivateClientSpawnOutdoorEntity(levelName, entity)) {
            return false;
        }

        const team = Number(entity?.team ?? 0);
        if (team === 2) {
            return LevelConfig.isDungeonLevel(levelName);
        }

        if (team === 3) {
            return levelName === 'CraftTownTutorial' || LevelConfig.isDungeonLevel(levelName);
        }

        return false;
    }

    private static getLevelMap(
        levelName: string | null | undefined,
        levelInstanceId: string = '',
        createIfMissing: boolean = false
    ): Map<number, any> | null {
        const rawLevelName = String(levelName ?? '');
        const scopeKey = rawLevelName.includes('#') && !levelInstanceId
            ? rawLevelName
            : getLevelScopeKey(rawLevelName, levelInstanceId);
        if (!scopeKey) {
            return null;
        }

        let levelMap = GlobalState.levelEntities.get(scopeKey) ?? null;
        if (!levelMap && createIfMissing) {
            levelMap = new Map<number, any>();
            GlobalState.levelEntities.set(scopeKey, levelMap);
        }

        return levelMap;
    }

    private static getLevelMapForClient(
        client: Pick<Client, 'currentLevel' | 'levelInstanceId'>,
        createIfMissing: boolean = false
    ): Map<number, any> | null {
        return EntityHandler.getLevelMap(client.currentLevel, client.levelInstanceId, createIfMissing);
    }

    private static isPartySharedClientSpawnHostile(levelName: string | null | undefined, entity: any): boolean {
        return EntityHandler.isSharedClientSpawnRegionActor(levelName, entity) &&
            Number(entity?.team ?? 0) === 2 &&
            DungeonCompletionConditions.sharesClientHostileWithParty(levelName, entity);
    }

    private static isPrivateClientSpawnDungeonHostile(levelName: string | null | undefined, entity: any): boolean {
        return EntityHandler.isSharedClientSpawnRegionActor(levelName, entity) &&
            Number(entity?.team ?? 0) === EntityTeam.ENEMY &&
            !DungeonCompletionConditions.sharesClientHostileWithParty(levelName, entity);
    }

    private static findLeaderAuthoritativeClientSpawnMatch(
        levelMap: Map<number, any> | null,
        entity: any
    ): any | null {
        if (!levelMap || !entity || entity.isPlayer) {
            return null;
        }

        const targetName = EntityHandler.normalizeIdentityName(entity.name);
        const targetTeam = Number(entity.team ?? 0);
        let bestMatch: any | null = null;
        let bestDistanceSq = Number.POSITIVE_INFINITY;

        for (const candidate of levelMap.values()) {
            if (!candidate || candidate.isPlayer) {
                continue;
            }
            if (Number(candidate.team ?? 0) !== targetTeam) {
                continue;
            }
            if (EntityHandler.normalizeIdentityName(candidate.name) !== targetName) {
                continue;
            }

            const dx = Number(candidate.x ?? 0) - Number(entity.x ?? 0);
            const dy = Number(candidate.y ?? 0) - Number(entity.y ?? 0);
            const distanceSq = (dx * dx) + (dy * dy);
            if (distanceSq < bestDistanceSq) {
                bestDistanceSq = distanceSq;
                bestMatch = candidate;
            }
        }

        return bestMatch;
    }

    private static suppressFollowerLeaderAuthoritativeDungeonSpawn(
        client: Client,
        levelName: string | null | undefined,
        levelMap: Map<number, any> | null,
        entity: any
    ): boolean {
        const partyId = getPartyIdForClient(client);
        if (
            !EntityHandler.usesLeaderAuthoritativeClientSpawns(levelName) ||
            !entity ||
            entity.isPlayer ||
            (Number(entity.team ?? 0) !== 2 && Number(entity.team ?? 0) !== 3) ||
            partyId <= 0
        ) {
            return false;
        }

        const canonical =
            (levelMap && levelMap.get(Number(entity.id ?? 0))) ??
            EntityHandler.findLeaderAuthoritativeClientSpawnMatch(levelMap, entity);
        // Non-leader suppression is only valid after a canonical shared hostile
        // already exists in-scope and can replace the follower's local spawn.
        if (!canonical) {
            return false;
        }

        const localId = Math.max(0, Math.round(Number(entity.id ?? 0) || 0));
        const canonicalId = Math.max(0, Math.round(Number(canonical.id ?? 0) || 0));
        if (localId <= 0 || canonicalId <= 0) {
            return false;
        }

        if (localId !== canonicalId) {
            EntityHandler.rememberEntityAlias(client, localId, canonicalId);
            client.knownEntityIds.delete(localId);
        }
        EntityHandler.registerCanonicalHostileAlias(
            client,
            getClientLevelScope(client),
            canonical,
            localId,
            localId === canonicalId ? 'same_id_leader_spawn_match' : 'follower_spawn_match'
        );

        EntityHandler.setSharedEntityRemoteUpdatesDeferred(
            client,
            canonicalId,
            Math.round(Number(entity.v ?? 0)) !== 0
        );
        client.knownEntityIds.add(canonicalId);
        // The follower's own spawn is a fresh copy: full health, standing on the
        // authored spawn point, however long the party has already been fighting
        // this enemy. Storing it verbatim left that copy authoritative on the
        // follower's screen until the next hit anyone landed — and for the
        // position, permanently, since the relay that follows only carries deltas.
        // The sibling dedupe path already reconciles a stale local spawn against
        // the canonical; this one has to as well.
        client.entities.set(localId, {
            ...EntityHandler.syncDamagedSharedCanonicalToLocalSpawn(client, localId, entity, canonical),
            canonicalEntityId: canonicalId,
            sharedCanonicalId: canonicalId
        });
        return true;
    }

    private static getSharedClientSpawnOwnerPartyId(entity: any): number {
        const ownerSession = EntityHandler.resolveEntityOwnerSession(entity);
        if (ownerSession?.character) {
            const livePartyId = getPartyIdForClient(ownerSession);
            entity.ownerPartyId = livePartyId > 0 ? livePartyId : 0;
            return livePartyId;
        }

        const storedPartyId = Number(entity?.ownerPartyId ?? 0);
        return storedPartyId > 0 ? storedPartyId : 0;
    }

    private static findBestSharedClientSpawnCanonicalMatch(
        levelName: string,
        levelMap: Map<number, any>,
        partyId: number,
        roomId: number,
        entity: any,
        excludedOwnerToken: number,
        requireSharedRoom: boolean
    ): any | null {
        const targetName = EntityHandler.normalizeIdentityName(entity?.name);
        const targetTeam = Number(entity?.team ?? 0);
        const targetObjectiveRole = DungeonCompletionConditions.getObjectiveRole(levelName, entity);
        const targetSpawnKey = String(entity?.spawnKey ?? EntityHandler.getHostileSpawnKey(getLevelScopeKey(levelName, ''), entity));
        let bestMatch: any | null = null;
        let bestDistanceSq = Number.POSITIVE_INFINITY;

        for (const candidate of levelMap.values()) {
            if (!EntityHandler.isSharedClientSpawnRegionActor(levelName, candidate)) {
                continue;
            }
            const candidateId = Math.max(0, Math.round(Number(candidate?.id ?? 0)));
            const entityId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
            if (Number(candidate?.ownerToken ?? 0) === excludedOwnerToken && candidateId === entityId) {
                continue;
            }
            if (partyId > 0) {
                if (EntityHandler.getSharedClientSpawnOwnerPartyId(candidate) !== partyId) {
                    continue;
                }
            }
            if (requireSharedRoom && !sharesRoomIds(roomId, Number(candidate?.roomId ?? -1))) {
                continue;
            }
            const candidateSpawnKey = String(candidate?.spawnKey ?? '');
            if (targetSpawnKey && candidateSpawnKey && targetSpawnKey === candidateSpawnKey) {
                return candidate;
            }
            // Authored objectives can intentionally place several objects with
            // the same type in one dungeon. Only an exact spawn key may merge
            // those copies; name-only matching would collapse distinct chests
            // and make required destruction counts unreachable.
            if (
                targetObjectiveRole &&
                DungeonCompletionConditions.getObjectiveRole(levelName, candidate) === targetObjectiveRole
            ) {
                continue;
            }
            if (EntityHandler.normalizeIdentityName(candidate?.name) !== targetName) {
                continue;
            }
            if (Number(candidate?.team ?? 0) !== targetTeam) {
                continue;
            }

            const dx = Number(candidate?.x ?? 0) - Number(entity?.x ?? 0);
            const dy = Number(candidate?.y ?? 0) - Number(entity?.y ?? 0);
            const distanceSq = (dx * dx) + (dy * dy);
            if (distanceSq < bestDistanceSq) {
                bestDistanceSq = distanceSq;
                bestMatch = candidate;
            }
        }

        return bestMatch;
    }

    private static findSharedClientSpawnCanonicalMatch(
        levelName: string,
        levelMap: Map<number, any>,
        partyId: number,
        roomId: number,
        entity: any,
        excludedOwnerToken: number
    ): any | null {
        const exactRoomMatch = EntityHandler.findBestSharedClientSpawnCanonicalMatch(
            levelName,
            levelMap,
            partyId,
            roomId,
            entity,
            excludedOwnerToken,
            true
        );
        if (exactRoomMatch) {
            return exactRoomMatch;
        }

        const targetTeam = Number(entity?.team ?? 0);
        if (targetTeam !== 2 || !LevelConfig.isDungeonLevel(levelName)) {
            return null;
        }

        // A dungeon holds exactly one of each required boss, so a second cue
        // carrying that boss name is always the same encounter even when its room
        // id has not synced — Tag Ugo's cues arrive with room ids like 2362519204
        // and 0. A solo run has no party id, which used to skip this fallback
        // entirely and let the stray cue become a second canonical: a motionless
        // Tag Ugo that kept every debuff ever applied to it. Ordinary hostiles
        // still need the party guard, because a level legitimately places many
        // enemies of one type and merging them across rooms would lose kills.
        if (partyId <= 0 && !DungeonCompletionConditions.isRequiredBoss(levelName, entity)) {
            return null;
        }

        // Joiners can be in the correct dungeon instance before their room state syncs.
        return EntityHandler.findBestSharedClientSpawnCanonicalMatch(
            levelName,
            levelMap,
            partyId,
            roomId,
            entity,
            excludedOwnerToken,
            false
        );
    }

    private static estimateClientSpawnHostileMaxHp(entity: any, levelName: string | null | undefined = ''): number {
        const explicitMaxHp = Math.max(0, Math.round(Number(entity?.maxHp ?? 0)));
        if (explicitMaxHp > 0) {
            return explicitMaxHp;
        }

        const explicitHp = Math.max(0, Math.round(Number(entity?.hp ?? 0)));
        const entType = GameData.getEntType(String(entity?.name ?? '')) ?? {};
        const rawLevel = Number(entity?.level ?? entType?.Level ?? entType?.baseLevel ?? entType?.ExpLevel ?? 1);
        const hitPointScale = Number(entity?.HitPoints ?? entity?.hitPoints ?? entType?.HitPoints ?? NaN);
        if (Number.isFinite(hitPointScale) && hitPointScale > 0) {
            const tier = LevelConfig.getHostileHpTier(
                levelName,
                rawLevel,
                Number(entType?.Level ?? entType?.baseLevel ?? entType?.ExpLevel ?? 0)
            );
            return Math.max(1, Math.round(
                EntityHandler.getHostileBaseHpForLevel(tier) * hitPointScale
            ));
        }

        return explicitHp > 0 ? explicitHp : 1;
    }

    private static normalizeHybridClientSpawnHostileCanonical(
        client: Client,
        levelName: string | null | undefined,
        levelMap: Map<number, any> | null,
        entity: any,
        rawEntityId: number
    ): boolean {
        if (
            !levelName ||
            !levelMap ||
            !LevelConfig.isDungeonLevel(levelName) ||
            EntityHandler.usesServerAuthorityHostiles(levelName) ||
            EntityHandler.isPrivateClientSpawnDungeonHostile(levelName, entity) ||
            !entity ||
            entity.isPlayer ||
            Number(entity.team ?? 0) !== EntityTeam.ENEMY
        ) {
            return false;
        }

        const localId = Math.max(0, Math.round(Number(rawEntityId || entity.id) || 0));
        if (localId <= 0) {
            return false;
        }

        const partyId = getPartyIdForClient(client);
        const roomId = Number.isFinite(Number(entity?.roomId)) ? Math.round(Number(entity.roomId)) : -1;
        entity.spawnKey = entity.spawnKey || EntityHandler.getHostileSpawnKey(getLevelScopeKey(levelName, client.levelInstanceId), entity);
        const duplicate = EntityHandler.findSharedClientSpawnCanonicalMatch(
            levelName,
            levelMap,
            partyId,
            roomId,
            entity,
            client.token
        );
        if (duplicate) {
            return false;
        }

        const maxHp = EntityHandler.estimateClientSpawnHostileMaxHp(entity, levelName);
        const rawHp = Number(entity.hp ?? NaN);
        const rawDelta = Number(entity.healthDelta ?? entity.health_delta ?? NaN);
        const dead = Boolean(entity.dead) || Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD;
        const hp = dead
            ? 0
            : Number.isFinite(rawHp) && Math.round(rawHp) > 0
                ? Math.min(maxHp, Math.round(rawHp))
                : Number.isFinite(rawDelta)
                    ? Math.max(1, Math.min(maxHp, maxHp + Math.round(rawDelta)))
                    : maxHp;
        const healthDelta = hp - maxHp;

        entity.id = localId;
        entity.clientSpawned = false;
        entity.hybridCanonicalHostile = true;
        entity.canonicalEntityId = undefined;
        entity.sharedCanonicalId = undefined;
        entity.ownerToken = client.token || 0;
        entity.aiOwnerToken = client.token || 0;
        entity.ownerUserId = client.userId || 0;
        entity.ownerCharacterName = client.character?.name || '';
        entity.ownerPartyId = partyId;
        entity.roomId = roomId;
        entity.hp = hp;
        entity.maxHp = maxHp;
        entity.healthDelta = healthDelta;
        entity.health_delta = healthDelta;
        entity.dead = dead || hp <= 0;
        entity.entState = entity.dead ? EntityState.DEAD : Number(entity.entState ?? EntityState.ACTIVE);
        entity.activeBuffs = entity.activeBuffs && typeof entity.activeBuffs === 'object' && !Array.isArray(entity.activeBuffs)
            ? entity.activeBuffs
            : {};
        entity.buffStateVersion = Math.max(0, Math.round(Number(entity.buffStateVersion ?? 0)));
        EntityHandler.registerCanonicalHostileAlias(
            client,
            getLevelScopeKey(levelName, client.levelInstanceId),
            entity,
            localId,
            'owner_spawn_canonical'
        );
        return false;
    }

    /**
     * Record that this client knows `canonicalEntityId` under its own `localEntityId`.
     *
     * **A session's own body is never a valid key.** Sixteen call sites can land here and none of
     * them checked; an entry keyed on `client.clientEntID` silently rewrote the source of that
     * player's own swings, and `isAuthorizedNetworkCombatSource` then refused every one of them
     * (`dropped=20:unauthorized_source` against a live 161472 pool, with the other member's
     * damage the only thing reaching the canonical). The combat paths now guard themselves --
     * see `CombatHandler.resolveCombatEntityIdForClient` -- but an alias like this is wrong for
     * every other reader too, so it is refused at the source and the caller is named. The log is
     * the point: it says which of the sixteen writes it.
     */
    static rememberEntityAlias(client: Client, localEntityId: number, canonicalEntityId: number): void {
        const localId = Math.max(0, Math.round(Number(localEntityId) || 0));
        const canonicalId = Math.max(0, Math.round(Number(canonicalEntityId) || 0));
        if (localId <= 0 || canonicalId <= 0 || localId === canonicalId) {
            return;
        }

        const ownBodyId = Math.max(0, Math.round(Number(client?.clientEntID ?? 0)));
        if (ownBodyId > 0 && localId === ownBodyId) {
            const caller = String(new Error().stack ?? '')
                .split('\n')
                .slice(2, 5)
                .map((line) => line.trim().replace(/^at\s+/, ''))
                .join(' <- ');
            console.log(
                `[AliasRefused] ${String(client.currentLevel ?? '?')} ` +
                `player=${String(client.character?.name ?? '?')} ownBody=${ownBodyId} ` +
                `-> canonical=${canonicalId} from: ${caller}`
            );
            return;
        }

        client.entityIdAliases.set(localId, canonicalId);
    }

    static isClientOwnPlayerEntity(client: Client, levelScope: string | null | undefined, entityId: number, entity: any = null): boolean {
        const id = Math.max(0, Math.round(Number(entityId) || 0));
        if (id <= 0 || client.clientEntID <= 0 || id !== client.clientEntID || !client.character) {
            return false;
        }

        const candidate = entity ?? client.entities.get(id) ?? (levelScope ? GlobalState.levelEntities.get(levelScope)?.get(id) : null);
        if (candidate && typeof candidate === 'object') {
            if (!Boolean(candidate.isPlayer)) {
                return false;
            }

            const ownerToken = Math.round(Number(candidate.ownerToken ?? 0));
            if (ownerToken > 0 && ownerToken !== client.token) {
                return false;
            }

            const ownerUserId = Math.round(Number(candidate.ownerUserId ?? 0));
            if (ownerUserId > 0 && client.userId && ownerUserId !== client.userId) {
                return false;
            }

            const entityName = EntityHandler.normalizeIdentityName(candidate.ownerCharacterName ?? candidate.name ?? candidate.characterName);
            const characterName = EntityHandler.normalizeIdentityName(client.character?.name);
            return !entityName || !characterName || entityName === characterName;
        }

        return true;
    }

    private static isEntityOwnedByClientPlayer(client: Client, entityId: number, entity: any): boolean {
        const id = Math.max(0, Math.round(Number(entityId) || 0));
        if (id <= 0 || !entity || !Boolean(entity.isPlayer)) {
            return false;
        }

        const ownerToken = Math.round(Number(entity.ownerToken ?? 0));
        if (ownerToken > 0) {
            return ownerToken === client.token;
        }

        const ownerUserId = Math.round(Number(entity.ownerUserId ?? 0));
        if (ownerUserId > 0 && client.userId) {
            return ownerUserId === client.userId;
        }

        const entityName = EntityHandler.normalizeIdentityName(entity.ownerCharacterName ?? entity.name ?? entity.characterName);
        const characterName = EntityHandler.normalizeIdentityName(client.character?.name);
        return Boolean(characterName && entityName && entityName === characterName);
    }

    /**
     * The id a session's own client uses for its own body.
     *
     * When the server reallocates a colliding player id it stores `local -> canonical` in
     * `entityIdAliases` and migrates its own bookkeeping to the canonical id -- but the client
     * never hears about that and goes on calling its own body by the original id. Nothing else
     * records it, so that id *looks* free to every occupancy check here.
     *
     * It is not free, and handing it to that client is the worst thing this code can do: the
     * spawn reader looks the id up, finds the client's own body, destroys it and rebuilds it as
     * somebody else. The client's next self update puts its own body back under the same id,
     * destroying the copy again -- a flip-flop in which neither player's body ever survives on
     * the other's screen while both still see themselves, and the party frame reads 0ft because
     * the entity filed under the other player's name is the viewer's own body.
     */
    private static getLocalSelfEntityId(session: Client): number {
        const canonicalId = Math.max(0, Math.round(Number(session.clientEntID) || 0));
        if (canonicalId <= 0) {
            return 0;
        }

        for (const [localId, aliasedId] of session.entityIdAliases ?? []) {
            if (aliasedId === canonicalId) {
                return Math.max(0, Math.round(Number(localId) || 0));
            }
        }

        return canonicalId;
    }

    private static isPlayerEntityIdOccupiedByOther(levelScope: string, client: Client, entityId: number): boolean {
        const id = Math.max(0, Math.round(Number(entityId) || 0));
        if (!levelScope || id <= 0) {
            return false;
        }

        const levelEntity = GlobalState.levelEntities.get(levelScope)?.get(id);
        if (levelEntity && !EntityHandler.isEntityOwnedByClientPlayer(client, id, levelEntity)) {
            return true;
        }

        for (const other of GlobalState.getSessionsInLevelScope(levelScope)) {
            if (other === client || getClientLevelScope(other) !== levelScope) {
                continue;
            }
            if (other.clientEntID === id && other.character) {
                return true;
            }
            // Also the id that client still calls its own body by, which no other record holds.
            if (other.character && EntityHandler.getLocalSelfEntityId(other) === id) {
                return true;
            }

            const otherEntity = other.entities.get(id);
            if (otherEntity && EntityHandler.isEntityOwnedByClientPlayer(other, id, otherEntity)) {
                return true;
            }
        }

        return false;
    }

    private static isPlayerCanonicalIdFree(levelScope: string, client: Client, entityId: number): boolean {
        const id = Math.max(0, Math.round(Number(entityId) || 0));
        if (!levelScope || id <= 0) {
            return false;
        }

        const levelEntity = GlobalState.levelEntities.get(levelScope)?.get(id);
        if (levelEntity && !EntityHandler.isEntityOwnedByClientPlayer(client, id, levelEntity)) {
            return false;
        }

        for (const other of GlobalState.getSessionsInLevelScope(levelScope)) {
            if (other === client || getClientLevelScope(other) !== levelScope) {
                continue;
            }
            if (other.clientEntID === id && other.character) {
                return false;
            }
            if (other.character && EntityHandler.getLocalSelfEntityId(other) === id) {
                return false;
            }
            if (other.entities.has(id)) {
                return false;
            }
        }

        const localEntity = client.entities.get(id);
        return !localEntity || EntityHandler.isEntityOwnedByClientPlayer(client, id, localEntity);
    }

    private static allocateCanonicalPlayerEntityId(client: Client, levelScope: string, rawEntityId: number): number {
        const rawId = Math.max(0, Math.round(Number(rawEntityId) || 0));
        if (rawId <= 0) {
            return rawId;
        }

        if (!EntityHandler.isPlayerEntityIdOccupiedByOther(levelScope, client, rawId)) {
            return rawId;
        }

        let candidate = rawId;
        const levelMap = GlobalState.levelEntities.get(levelScope);
        for (const id of levelMap?.keys() ?? []) {
            candidate = Math.max(candidate, Math.round(Number(id) || 0));
        }
        for (const session of GlobalState.getSessionsInLevelScope(levelScope)) {
            if (getClientLevelScope(session) !== levelScope) {
                continue;
            }
            candidate = Math.max(candidate, Math.round(Number(session.clientEntID) || 0));
            for (const id of session.entities.keys()) {
                candidate = Math.max(candidate, Math.round(Number(id) || 0));
            }
        }

        candidate = Math.max(candidate + 1, rawId + 1);
        while (!EntityHandler.isPlayerCanonicalIdFree(levelScope, client, candidate)) {
            candidate++;
        }

        return candidate;
    }

    private static migrateOwnedPlayerEntityId(client: Client, levelMap: Map<number, any> | null, rawEntityId: number, canonicalEntityId: number): void {
        const rawId = Math.max(0, Math.round(Number(rawEntityId) || 0));
        const canonicalId = Math.max(0, Math.round(Number(canonicalEntityId) || 0));
        if (rawId <= 0 || canonicalId <= 0 || rawId === canonicalId) {
            return;
        }

        const localEntity = client.entities.get(rawId);
        if (EntityHandler.isEntityOwnedByClientPlayer(client, rawId, localEntity)) {
            client.entities.delete(rawId);
            client.entities.set(canonicalId, {
                ...localEntity,
                id: canonicalId
            });
        }

        const levelEntity = levelMap?.get(rawId);
        if (EntityHandler.isEntityOwnedByClientPlayer(client, rawId, levelEntity)) {
            levelMap?.delete(rawId);
            levelMap?.set(canonicalId, {
                ...levelEntity,
                id: canonicalId
            });
        }

        client.knownEntityIds.delete(rawId);
        client.knownEntityIds.add(canonicalId);
    }

    private static getDeferredRemoteUpdateIds(client: Client): Set<number> {
        const dynamicClient = client as Client & { sharedEntityRemoteUpdateDeferredIds?: Set<number> };
        if (!dynamicClient.sharedEntityRemoteUpdateDeferredIds) {
            dynamicClient.sharedEntityRemoteUpdateDeferredIds = new Set<number>();
        }

        return dynamicClient.sharedEntityRemoteUpdateDeferredIds;
    }

    private static setSharedEntityRemoteUpdatesDeferred(
        client: Client,
        canonicalEntityId: number,
        deferred: boolean
    ): void {
        const canonicalId = Math.max(0, Math.round(Number(canonicalEntityId) || 0));
        if (canonicalId <= 0) {
            return;
        }

        const deferredIds = EntityHandler.getDeferredRemoteUpdateIds(client);
        if (deferred) {
            deferredIds.add(canonicalId);
        } else {
            deferredIds.delete(canonicalId);
        }
    }

    static markSharedEntityRemoteUpdatesReady(client: Client, canonicalEntityId: number): void {
        EntityHandler.setSharedEntityRemoteUpdatesDeferred(client, canonicalEntityId, false);
    }

    static resolveEntityLocalId(client: Client, canonicalEntityId: number): number {
        const canonicalId = Math.max(0, Math.round(Number(canonicalEntityId) || 0));
        if (canonicalId <= 0) {
            return canonicalId;
        }

        for (const [localId, mappedCanonicalId] of (client.entityIdAliases ?? new Map<number, number>()).entries()) {
            if (Math.max(0, Math.round(Number(mappedCanonicalId) || 0)) === canonicalId) {
                const mappedLocalId = Math.max(0, Math.round(Number(localId) || 0));
                if (
                    mappedLocalId > 0 &&
                    (client.entities?.has(mappedLocalId) || client.knownEntityIds?.has(mappedLocalId))
                ) {
                    return mappedLocalId;
                }
            }
        }

        return canonicalId;
    }

    static canClientResolveCanonicalEntity(client: Client, canonicalEntityId: number): boolean {
        const canonicalId = Math.max(0, Math.round(Number(canonicalEntityId) || 0));
        if (canonicalId <= 0) {
            return true;
        }

        if (EntityHandler.getDeferredRemoteUpdateIds(client).has(canonicalId)) {
            return false;
        }

        if (client.knownEntityIds?.has(canonicalId) || client.entities?.has(canonicalId)) {
            return true;
        }

        const localId = EntityHandler.resolveEntityLocalId(client, canonicalId);
        return localId !== canonicalId && Boolean(client.entities?.has(localId));
    }

    static resolveEntityAlias(client: Client, entityId: number): number {
        const localId = Math.max(0, Math.round(Number(entityId) || 0));
        if (localId <= 0) {
            return localId;
        }

        let resolvedId = localId;
        const seen = new Set<number>();
        const aliases = client.entityIdAliases ?? new Map<number, number>();
        while (aliases.has(resolvedId) && !seen.has(resolvedId)) {
            seen.add(resolvedId);
            resolvedId = Math.max(0, Math.round(Number(aliases.get(resolvedId)) || 0));
        }

        return resolvedId > 0 ? resolvedId : localId;
    }

    private static sendDeadSharedCanonicalCleanup(client: Client, localEntityId: number, entity: any, canonical: any): void {
        const localId = Math.max(0, Math.round(Number(localEntityId) || 0));
        if (localId <= 0) {
            return;
        }

        const maxHp = Math.max(
            0,
            Math.round(Number(entity?.maxHp ?? canonical?.maxHp ?? entity?.hp ?? canonical?.hp ?? 0) || 0)
        );
        if (maxHp > 0) {
            client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -EntityHandler.resolveLethalHostileDelta(getClientLevelScope(client), canonical ?? entity ?? null, client.entities.get(localId))));
        }
        client.send(0x07, EntityHandler.buildEntityStateDeadPayload(localId));
        client.send(0x0D, EntityHandler.buildDestroyEntityPayload(localId));
        client.entities.delete(localId);
    }

    private static syncDamagedSharedCanonicalToLocalSpawn(
        client: Client,
        localEntityId: number,
        entity: any,
        canonical: any
    ): any {
        const localId = Math.max(0, Math.round(Number(localEntityId) || 0));
        const maxHp = Math.max(0, Math.round(Number(canonical?.maxHp ?? entity?.maxHp ?? entity?.hp ?? 0) || 0));
        const canonicalHpRaw = Number(canonical?.hp);
        const canonicalHp = Number.isFinite(canonicalHpRaw)
            ? Math.max(0, Math.min(maxHp || Number.MAX_SAFE_INTEGER, Math.round(canonicalHpRaw)))
            : maxHp;
        const damageTaken = maxHp > 0 ? Math.max(0, maxHp - canonicalHp) : 0;
        if (localId > 0 && damageTaken > 0) {
            client.send(0x78, EntityHandler.buildHpDeltaPayload(localId, -damageTaken));
        }

        // The health was only half the debt. The local spawn also arrives standing
        // on the authored spawn point while the shared enemy has been walking
        // around the room, and the movement stream that follows carries deltas
        // only — so an absolute offset introduced here is never closed by anything
        // downstream. Every party member ends up fighting the same enemy at a
        // different place on their screen. Snap it once, at the same moment the
        // health is snapped.
        const canonicalX = Math.round(Number(canonical?.x ?? NaN));
        const canonicalY = Math.round(Number(canonical?.y ?? NaN));
        const hasCanonicalPosition = Number.isFinite(canonicalX) && Number.isFinite(canonicalY);
        const deltaX = hasCanonicalPosition ? canonicalX - Math.round(Number(entity?.x ?? 0)) : 0;
        const deltaY = hasCanonicalPosition ? canonicalY - Math.round(Number(entity?.y ?? 0)) : 0;
        if (localId > 0 && (deltaX !== 0 || deltaY !== 0)) {
            client.send(
                0x07,
                EntityHandler.buildEntityCatchUpMovePayload(
                    localId,
                    deltaX,
                    deltaY,
                    Number(canonical?.entState ?? EntityState.ACTIVE),
                    Boolean(canonical?.facingLeft)
                )
            );
        }

        return {
            ...entity,
            x: hasCanonicalPosition ? canonicalX : entity?.x,
            y: hasCanonicalPosition ? canonicalY : entity?.y,
            hp: maxHp > 0 ? canonicalHp : entity?.hp,
            maxHp: maxHp > 0 ? maxHp : entity?.maxHp,
            healthDelta: maxHp > 0 ? canonicalHp - maxHp : entity?.healthDelta,
            health_delta: maxHp > 0 ? canonicalHp - maxHp : entity?.health_delta,
            dead: false,
            entState: Number(entity?.entState ?? canonical?.entState ?? EntityState.ACTIVE) === EntityState.DEAD
                ? EntityState.ACTIVE
                : Number(entity?.entState ?? canonical?.entState ?? EntityState.ACTIVE),
            combatAuthorityToken: canonical?.combatAuthorityToken,
            firstCombatAuthorityToken: canonical?.firstCombatAuthorityToken,
            combatAuthorityName: canonical?.combatAuthorityName,
            firstCombatAuthorityName: canonical?.firstCombatAuthorityName,
            combatAuthorityStartedAt: canonical?.combatAuthorityStartedAt,
            firstCombatAuthorityStartedAt: canonical?.firstCombatAuthorityStartedAt
        };
    }

    // The boss-scene sweep only sees copies that already exist when BossFight
    // announces the encounter; the Dread Goblin Hideout copy registers after that
    // packet, which is why it survived until the boss died. Once the room boss is
    // marked, that marker is the authoritative real boss, so any later cue for the
    // same canonical boss is the copy — the one that never moves and keeps every
    // debuff. Retire it on arrival so it is never drawn in the boss scene.
    private static suppressLateDuplicateRoomBossSpawn(
        client: Client,
        levelName: string | null | undefined,
        levelMap: Map<number, any> | null,
        entity: any,
        entityId: number
    ): boolean {
        if (
            !levelName ||
            !levelMap ||
            !entity ||
            entity.isPlayer ||
            entityId <= 0 ||
            Number(entity.team ?? 0) !== EntityTeam.ENEMY ||
            !LevelConfig.isDungeonLevel(levelName)
        ) {
            return false;
        }

        const levelScope = getClientLevelScope(client);
        const canonicalBoss = DungeonCompletionConditions.getCanonicalBossName(levelName, entity, levelScope);
        if (!canonicalBoss) {
            return false;
        }

        // Every arrival of a required boss, with the two facts that decide whether
        // the duplicate guards can act: whether this cue is the marked room boss,
        // and which scope entities currently carry a room-boss marker. If a copy
        // slips through, this line names it and shows why nothing anchored on it.
        if (String(process.env.DUNGEON_DIAG ?? '1').trim() !== '0') {
            console.log(`[DUNGEON-DIAG] requiredBossSpawn ${JSON.stringify({
                level: levelName,
                scope: levelScope,
                canonicalBoss,
                entityId,
                name: String(entity?.name ?? ''),
                roomId: entity?.roomId,
                // The copy arrives at the boss's authored spawn point and never
                // leaves it, so its position is what identifies it later.
                x: Math.round(Number(entity?.x ?? 0)),
                y: Math.round(Number(entity?.y ?? 0)),
                clientSpawned: Boolean(entity?.clientSpawned),
                ownerToken: entity?.ownerToken,
                isMarkedRoomBoss: isRoomBossEntity(levelScope, entity),
                openBossScene: getOpenBossScene(levelScope),
                scopeBossEntities: [...levelMap.entries()]
                    .filter(([, candidate]) => Boolean(
                        DungeonCompletionConditions.getCanonicalBossName(levelName, candidate, levelScope)
                    ))
                    .map(([candidateId, candidate]) => ({
                        id: candidateId,
                        name: String(candidate?.name ?? ''),
                        marked: isRoomBossEntity(levelScope, candidate),
                        clientSpawned: Boolean(candidate?.clientSpawned),
                        roomId: candidate?.roomId,
                        hp: candidate?.hp
                    }))
            })}`);
        }

        if (isRoomBossEntity(levelScope, entity)) {
            return false;
        }

        for (const [existingId, existing] of levelMap.entries()) {
            if (
                existingId === entityId ||
                !isRoomBossEntity(levelScope, existing) ||
                DungeonCompletionConditions.getCanonicalBossName(levelName, existing, levelScope) !== canonicalBoss
            ) {
                continue;
            }

            // The destroy clears the alias, so re-point the id afterwards: damage
            // the client already sent under it must still reach the real boss.
            EntityHandler.destroyClientLocalEntity(client, entityId, 'late_duplicate_room_boss', entity);
            EntityHandler.rememberEntityAlias(client, entityId, existingId);
            console.log('[EntityHandler] Suppressed late duplicate room boss', {
                scope: levelScope,
                canonicalBoss,
                keptEntityId: existingId,
                suppressedEntityId: entityId
            });
            return true;
        }

        return EntityHandler.suppressSecondLocalBossVisual(client, levelName, levelScope, entity, entityId);
    }

    // The marker sweep above can only act when the announced boss id resolves to a
    // shared entity. In Dread Goblin Hideout it does not — BossFight names an id
    // from the client's own space — so the copy walked straight past it and stood
    // in the scene until the rank plate. The invariant that does hold everywhere:
    // a client renders exactly one visual per dungeon boss. Once BossFight has
    // opened the scene, a second boss cue from a client that already holds one is
    // the stale copy, so retire it on arrival and alias its id onto the visual the
    // player is actually fighting.
    private static suppressSecondLocalBossVisual(
        client: Client,
        levelName: string,
        levelScope: string,
        entity: any,
        entityId: number
    ): boolean {
        const openScene = getOpenBossScene(levelScope);
        if (!openScene) {
            return false;
        }

        const bossKeys = getBossIdentityKeys(levelName);
        // Only a second cue for the *same* boss is a stale copy. A room that
        // authors two bosses (Svagg and the griffon he summons, the bandit twins)
        // sends a cue for each, and suppressing the second one left that boss
        // unkillable and its dungeon unable to finish.
        const bossIdentity = getBossIdentityKey(entity, bossKeys);
        if (!bossIdentity) {
            return false;
        }

        // Never suppress the entity BossFight itself announced.
        if (entityId === openScene.bossId) {
            return false;
        }

        const existingLocalIds: number[] = [];
        for (const [localId, localEntity] of client.entities?.entries() ?? []) {
            const normalizedLocalId = Math.max(0, Math.round(Number(localId) || 0));
            if (
                normalizedLocalId <= 0 ||
                normalizedLocalId === entityId ||
                localEntity === entity ||
                getBossIdentityKey(localEntity, bossKeys) !== bossIdentity
            ) {
                continue;
            }
            existingLocalIds.push(normalizedLocalId);
        }

        if (existingLocalIds.length === 0) {
            // This client has no boss visual yet, so this cue is the one they get.
            return false;
        }

        const keeperId = existingLocalIds.includes(openScene.bossId)
            ? openScene.bossId
            : Math.min(...existingLocalIds);

        EntityHandler.destroyClientLocalEntity(client, entityId, 'second_local_boss_visual', entity);
        EntityHandler.rememberEntityAlias(client, entityId, keeperId);

        if (String(process.env.DUNGEON_DIAG ?? '1').trim() !== '0') {
            console.log(`[DUNGEON-DIAG] secondLocalBossVisualSuppressed ${JSON.stringify({
                level: levelName,
                scope: levelScope,
                viewer: String(client.character?.name ?? ''),
                openedBossId: openScene.bossId,
                openedRoomId: openScene.roomId,
                suppressedEntityId: entityId,
                suppressedName: String(entity?.name ?? ''),
                keptEntityId: keeperId,
                otherLocalBossIds: existingLocalIds
            })}`);
        }

        return true;
    }

    private static suppressDuplicateSharedClientSpawn(
        client: Client,
        levelName: string | null | undefined,
        levelMap: Map<number, any> | null,
        entity: any
    ): boolean {
        if (
            !levelName ||
            !levelMap ||
            !EntityHandler.isSharedClientSpawnRegionActor(levelName, entity) ||
            EntityHandler.isPrivateClientSpawnDungeonHostile(levelName, entity)
        ) {
            return false;
        }

        const partyId = getPartyIdForClient(client);
        entity.ownerPartyId = partyId;

        const roomId = Number.isFinite(Number(entity?.roomId)) ? Number(entity.roomId) : -1;
        const canonical = EntityHandler.findSharedClientSpawnCanonicalMatch(
            levelName,
            levelMap,
            partyId,
            roomId,
            entity,
            client.token
        );
        if (!canonical) {
            return false;
        }

        const duplicateId = Number(entity?.id ?? 0);
        const canonicalId = Number(canonical?.id ?? 0);
        const levelScope = getClientLevelScope(client);
        canonical.spawnKey = canonical.spawnKey || EntityHandler.getHostileSpawnKey(levelScope, canonical);
        entity.spawnKey = entity.spawnKey || canonical.spawnKey || EntityHandler.getHostileSpawnKey(levelScope, entity);
        EntityHandler.registerCanonicalHostileAlias(
            client,
            levelScope,
            canonical,
            duplicateId,
            duplicateId === canonicalId ? 'same_id_spawn_match' : 'follower_spawn_match'
        );
        const canonicalHp = Number(canonical?.hp);
        const canonicalDead =
            Boolean(canonical?.dead) ||
            Number(canonical?.entState ?? EntityState.ACTIVE) === EntityState.DEAD ||
            (Number.isFinite(canonicalHp) && Math.round(canonicalHp) <= 0);

        if (canonicalId === duplicateId) {
            // Keep the shared canonical entity alive locally without forcing a destroy/respawn cycle.
            EntityHandler.setSharedEntityRemoteUpdatesDeferred(
                client,
                canonicalId,
                Math.round(Number(entity.v ?? 0)) !== 0
            );
            client.knownEntityIds.add(canonicalId);
            if (canonicalDead) {
                EntityHandler.sendDeadSharedCanonicalCleanup(client, duplicateId, entity, canonical);
            } else {
                const maxHp = Math.max(0, Math.round(Number(canonical?.maxHp ?? entity?.maxHp ?? entity?.hp ?? 0) || 0));
                const hp = Math.max(0, Math.round(Number(canonical?.hp ?? maxHp) || 0));
                if (maxHp > 0 && hp < maxHp) {
                    client.entities.set(
                        duplicateId,
                        EntityHandler.syncDamagedSharedCanonicalToLocalSpawn(client, duplicateId, entity, canonical)
                    );
                }
            }
            return true;
        }

        client.knownEntityIds.delete(duplicateId);
        EntityHandler.rememberEntityAlias(client, duplicateId, canonicalId);
        EntityHandler.setSharedEntityRemoteUpdatesDeferred(
            client,
            canonicalId,
            Math.round(Number(entity.v ?? 0)) !== 0
        );
        client.knownEntityIds.add(canonicalId);

        if (canonicalDead) {
            EntityHandler.sendDeadSharedCanonicalCleanup(client, duplicateId, entity, canonical);
            return true;
        }

        // Retaining the stray spawn as a local visual is right for a party member,
        // whose own copy is the only boss they can see. It is wrong for the owner
        // of the canonical: they already render that one, so the extra copy just
        // sits there. It receives no AI and no health updates, so it never moves
        // and keeps every debuff ever applied to it — the second Tag Ugo in Dread
        // Goblin Hideout. Drop it and let the canonical be the single visual.
        if (
            Number(canonical?.ownerToken ?? 0) === Number(client.token ?? 0) &&
            DungeonCompletionConditions.isRequiredBoss(levelName, entity)
        ) {
            // destroyClientLocalEntity clears the alias, so re-point the stray id
            // afterwards: damage the client already sent under it must still land.
            EntityHandler.destroyClientLocalEntity(client, duplicateId, 'boss_cue_duplicate_destroy', entity);
            EntityHandler.rememberEntityAlias(client, duplicateId, canonicalId);
            return true;
        }

        client.entities.set(duplicateId, {
            ...EntityHandler.syncDamagedSharedCanonicalToLocalSpawn(client, duplicateId, entity, canonical),
            canonicalEntityId: canonicalId,
            sharedCanonicalId: canonicalId
        });

        return true;
    }

    static shouldRelayEntityToOtherClients(levelName: string | null | undefined, entity: any): boolean {
        if (
            EntityHandler.isPrivateClientSpawnOutdoorEntity(levelName, entity) ||
            EntityHandler.isPrivateClientSpawnDungeonHostile(levelName, entity)
        ) {
            return false;
        }

        return !EntityHandler.isPartySharedClientSpawnHostile(levelName, entity);
    }

    static shouldMirrorClientSpawnEntityToParty(levelName: string | null | undefined, entity: any): boolean {
        return EntityHandler.isPartySharedClientSpawnHostile(levelName, entity);
    }

    static shouldTrackKnownEntity(levelName: string | null | undefined, entity: any): boolean {
        if (!entity) {
            return false;
        }
        if (!levelName) {
            return true;
        }

        return EntityHandler.shouldRelayEntityToOtherClients(levelName, entity);
    }

    private static canClientUsePartySharedClientSpawnEntity(client: Client, entity: any): boolean {
        if (!client.playerSpawned || !client.currentLevel || entity?.isPlayer) {
            return false;
        }
        if (!entity?.clientSpawned && !Boolean(entity?.hybridCanonicalHostile)) {
            return false;
        }
        if (!EntityHandler.isPartySharedClientSpawnHostile(client.currentLevel, entity)) {
            return false;
        }

        const clientPartyId = getPartyIdForClient(client);
        const ownerPartyId = EntityHandler.getSharedClientSpawnOwnerPartyId(entity);
        const ownerSession = EntityHandler.resolveEntityOwnerSession(entity);
        if (ownerSession?.playerSpawned && areClientsInSameLevelScope(client, ownerSession)) {
            if (ownerSession === client) {
                return true;
            }

            if (clientPartyId > 0 && ownerPartyId > 0 && areClientsInSameParty(client, ownerSession)) {
                return true;
            }
        }

        return clientPartyId > 0 && ownerPartyId > 0 && clientPartyId === ownerPartyId;
    }

    private static rememberEntityKnown(client: Client, levelName: string | null | undefined, entity: any): void {
        const entityId = Number(entity?.id ?? 0);
        if (entityId <= 0) {
            return;
        }

        if (
            EntityHandler.shouldTrackKnownEntity(levelName, entity) ||
            EntityHandler.canClientUsePartySharedClientSpawnEntity(client, entity)
        ) {
            client.knownEntityIds.add(entityId);
            return;
        }

        client.knownEntityIds.delete(entityId);
    }

    private static hasConflictingLocalKnownEntity(client: Client, levelName: string, entityId: number, entity: any): boolean {
        const localEntity = client.entities.get(entityId);
        if (!localEntity) {
            return false;
        }

        if (
            Boolean(localEntity?.clientSpawned) &&
            Boolean(entity?.clientSpawned) &&
            !Boolean(localEntity?.isPlayer) &&
            !Boolean(entity?.isPlayer) &&
            EntityHandler.normalizeIdentityName(localEntity?.name) === EntityHandler.normalizeIdentityName(entity?.name) &&
            Number(localEntity?.team ?? 0) === Number(entity?.team ?? 0)
        ) {
            return false;
        }

        if (EntityHandler.isPartySharedClientSpawnHostile(levelName, localEntity)) {
            return true;
        }

        if (Boolean(localEntity.isPlayer) !== Boolean(entity?.isPlayer)) {
            return true;
        }

        const localOwnerToken = Number(localEntity?.ownerToken ?? (entityId === client.clientEntID ? client.token : 0));
        const remoteOwnerToken = Number(entity?.ownerToken ?? 0);
        if (localOwnerToken > 0 && remoteOwnerToken > 0 && localOwnerToken !== remoteOwnerToken) {
            return true;
        }

        return false;
    }

    private static resolvePlayerSessionByEntityId(entityId: number, entity: any = null): Client | null {
        const ownerToken = Number(entity?.ownerToken ?? 0);
        if (ownerToken > 0) {
            const ownerSession = GlobalState.sessionsByToken.get(ownerToken);
            if (ownerSession?.clientEntID === entityId && ownerSession.character) {
                return ownerSession;
            }
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (other.clientEntID === entityId && other.character) {
                return other;
            }
        }

        return null;
    }

    private static resolveEntityOwnerSession(entity: any): Client | null {
        const ownerToken = Number(entity?.ownerToken ?? 0);
        if (ownerToken > 0) {
            const ownerSession = GlobalState.sessionsByToken.get(ownerToken);
            if (ownerSession?.character) {
                return ownerSession;
            }
        }

        return null;
    }

    private static getStartedRoomIdsForLevel(
        client: Pick<Client, 'startedRoomEvents'> | null | undefined,
        levelName: string | null | undefined
    ): number[] {
        const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
        if (!normalizedLevel || !client?.startedRoomEvents) {
            return [];
        }

        const prefix = `${normalizedLevel}:`;
        const roomIds = new Set<number>();
        for (const key of client.startedRoomEvents) {
            if (!key.startsWith(prefix)) {
                continue;
            }

            const roomId = Number(key.substring(prefix.length));
            if (Number.isFinite(roomId) && roomId >= 0) {
                roomIds.add(Math.round(roomId));
            }
        }

        return Array.from(roomIds).sort((left, right) => left - right);
    }

    private static sendRoomEventStartPacket(client: Client, roomId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod9(roomId);
        bb.writeMethod15(true);
        client.sendBitBuffer(0xA5, bb);
    }

    private static hasSharedDungeonCutsceneState(levelScope: string, roomId: number): boolean {
        if (!levelScope) {
            return false;
        }

        const normalizedRoomId = Math.max(0, Math.round(Number(roomId) || 0));
        return GlobalState.dungeonCutscenes.has(`${levelScope}:${normalizedRoomId}`);
    }

    private static replayStartedDungeonRoomEventsToJoiner(joiner: Client): void {
        const levelName = LevelConfig.normalizeLevelName(joiner.currentLevel);
        if (!levelName || !LevelConfig.isDungeonLevel(levelName) || !joiner.playerSpawned) {
            return;
        }
        if (EntityHandler.shouldSkipDungeonRoomProgressSync(levelName)) {
            return;
        }

        let anchor: Client | null = null;
        let anchorStartedRoomIds: number[] = [];

        for (const other of GlobalState.getSessionsInParty(getPartyIdForClient(joiner))) {
            if (other === joiner) {
                continue;
            }
            if (!other.playerSpawned || !areClientsInSameLevelScope(joiner, other) || !areClientsInSameParty(joiner, other)) {
                continue;
            }

            const startedRoomIds = EntityHandler.getStartedRoomIdsForLevel(other, levelName);
            if (startedRoomIds.length === 0) {
                continue;
            }

            if (
                !anchor ||
                startedRoomIds.length > anchorStartedRoomIds.length ||
                (startedRoomIds.length === anchorStartedRoomIds.length && Number(other.syncAnchorStartedAt ?? 0) > Number(anchor.syncAnchorStartedAt ?? 0))
            ) {
                anchor = other;
                anchorStartedRoomIds = startedRoomIds;
            }
        }

        if (!anchor || anchorStartedRoomIds.length === 0) {
            return;
        }

        const anchorRoomId = Number(anchor.currentRoomId ?? -1);
        const levelScope = getClientLevelScope(joiner);

        // A cinematic already running in the anchor's room takes the arrival with
        // it, resumed mid-timeline. Only a finished one is still skipped — that
        // one would replay dialogue the room is done with.
        const { LevelHandler } = require('./LevelHandler') as typeof import('./LevelHandler');
        if (
            Number.isFinite(anchorRoomId) &&
            anchorRoomId >= 0 &&
            LevelHandler.joinActiveSharedDungeonCutscene(joiner, anchorRoomId)
        ) {
            return;
        }

        if (
            Number.isFinite(anchorRoomId) &&
            anchorRoomId >= 0 &&
            !EntityHandler.hasSharedDungeonCutsceneState(levelScope, anchorRoomId)
        ) {
            joiner.currentRoomId = anchorRoomId;
            GlobalState.refreshSessionIndexes(joiner);
        }

        for (const roomId of anchorStartedRoomIds) {
            if (EntityHandler.hasSharedDungeonCutsceneState(levelScope, roomId)) {
                continue;
            }

            const key = `${levelName}:${roomId}`;
            if (joiner.startedRoomEvents.has(key)) {
                continue;
            }

            EntityHandler.sendRoomEventStartPacket(joiner, roomId);
            joiner.startedRoomEvents.add(key);
        }
    }

    static resolveCanonicalEntity(levelName: string, entityId: number): EntityProps | null {
        if (!levelName || entityId <= 0) {
            return null;
        }

        const entity = EntityHandler.getLevelMap(levelName)?.get(entityId);
        if (!entity) {
            return null;
        }

        if (entity.isPlayer) {
            const ownerSession = EntityHandler.resolvePlayerSessionByEntityId(entityId, entity);
            if (ownerSession?.character) {
                return Entity.fromCharacter(entityId, ownerSession.character, entity);
            }
        }

        if (entity.id && entity.entState !== undefined) {
            return entity as EntityProps;
        }

        return Entity.fromNpc(entity);
    }

    static canClientSeeEntity(client: Client, entity: any): boolean {
        if (!client.playerSpawned || !client.currentLevel || !entity) {
            return false;
        }

        if (entity.isPlayer) {
            return true;
        }

        if (EntityHandler.isPartySharedClientSpawnHostile(client.currentLevel, entity)) {
            return EntityHandler.canClientUsePartySharedClientSpawnEntity(client, entity);
        }

        if (!EntityHandler.shouldRelayEntityToOtherClients(client.currentLevel, entity)) {
            return false;
        }

        if (entity.clientSpawned) {
            const clientPartyId = getPartyIdForClient(client);
            const ownerPartyId = EntityHandler.getSharedClientSpawnOwnerPartyId(entity);
            if (clientPartyId > 0 && ownerPartyId > 0 && clientPartyId === ownerPartyId) {
                return true;
            }

            const ownerSession = EntityHandler.resolveEntityOwnerSession(entity);
            if (ownerSession && areClientsInSameLevelScope(client, ownerSession) && areClientsInSameParty(client, ownerSession)) {
                return true;
            }

            const entityRoomId = Number.isFinite(Number(entity?.roomId)) ? Number(entity.roomId) : -1;
            return sharesRoomIds(client.currentRoomId, entityRoomId);
        }

        return true;
    }

    static ensureEntityKnown(client: Client, levelName: string, entityId: number): boolean {
        if (entityId <= 0) {
            return true;
        }

        const entity = EntityHandler.getLevelMap(levelName, client.levelInstanceId)?.get(entityId);
        if (!entity || !EntityHandler.canClientSeeEntity(client, entity)) {
            return false;
        }

        // Player bodies are not this path's to place.
        //
        // Seeding one from here sends the raw level-map snapshot: no floor sample, no airborne
        // refusal, and delivered at whatever moment a relay happens to run -- including while
        // the receiving client is still loading its level, where it is simply discarded. That
        // left the id marked known with nothing on screen, and it also made this a *second*
        // sender competing with the visibility pass: each 0x0F rebuilds the body on the client,
        // so two of them a second apart is a body that is being destroyed and recreated instead
        // of drawn. One owner only.
        //
        // Send nothing and let the visibility pass place it -- but still answer yes, because
        // this is also the gate for ordinary relays (health, movement, buffs) and a player is
        // always entitled to those. Withholding them here stops a party member's damage from
        // ever reaching the other screens. Leaving `knownEntityIds` untouched is deliberate:
        // that is what tells the visibility pass this screen still has no body to draw.
        if (entity.isPlayer) {
            return true;
        }

        if (client.knownEntityIds.has(entityId)) {
            if (!EntityHandler.hasConflictingLocalKnownEntity(client, levelName, entityId, entity)) {
                return true;
            }

            client.knownEntityIds.delete(entityId);
        }

        const snapshot = EntityHandler.resolveCanonicalEntity(getLevelScopeKey(levelName, client.levelInstanceId), entityId);
        if (!snapshot) {
            return false;
        }

        EntityHandler.sendEntity(client, snapshot);
        return true;
    }

    static forgetKnownEntity(levelName: string, entityId: number, levelInstanceId: string = ''): void {
        if (!levelName || entityId <= 0) {
            return;
        }

        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);
        for (const other of GlobalState.getSessionsInLevelScope(scopeKey)) {
            if (getClientLevelScope(other) === scopeKey) {
                other.knownEntityIds.delete(entityId);
            }
        }
    }

    private static buildEntityFullUpdatePayload(entity: EntityProps): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entity.id);
        bb.writeMethod24(Math.round(Number(entity.x ?? 0)));
        bb.writeMethod24(Math.round(Number(entity.y ?? 0)));
        bb.writeMethod24(Math.round(Number(entity.v ?? 0)));
        bb.writeMethod26(entity.name ?? '');
        bb.writeMethod6(Number(entity.team ?? 0), Entity.TEAM_BITS);
        bb.writeMethod15(Boolean(entity.isPlayer));
        bb.writeMethod706(Math.round(Number(entity.renderDepthOffset ?? 0)));

        const characterName = String(entity.characterName ?? '');
        const dramaAnim = String(entity.dramaAnim ?? '');
        const sleepAnim = String(entity.sleepAnim ?? '');
        const hasCue = Boolean(characterName || dramaAnim || sleepAnim);
        bb.writeMethod15(hasCue);
        if (hasCue) {
            bb.writeMethod15(Boolean(characterName));
            if (characterName) {
                bb.writeMethod13(characterName);
            }
            bb.writeMethod15(Boolean(dramaAnim));
            if (dramaAnim) {
                bb.writeMethod13(dramaAnim);
            }
            bb.writeMethod15(Boolean(sleepAnim));
            if (sleepAnim) {
                bb.writeMethod13(sleepAnim);
            }
        }

        const summonerId = Number(entity.summonerId ?? 0);
        bb.writeMethod15(summonerId > 0);
        if (summonerId > 0) {
            bb.writeMethod4(summonerId);
        }

        const powerId = Number(entity.powerId ?? 0);
        bb.writeMethod15(powerId > 0);
        if (powerId > 0) {
            bb.writeMethod4(powerId);
        }

        bb.writeMethod6(Number(entity.entState ?? EntityState.ACTIVE), Entity.STATE_BITS);
        bb.writeMethod15(Boolean(entity.facingLeft));
        bb.writeMethod15(Boolean(entity.running));
        bb.writeMethod15(Boolean(entity.jumping));
        bb.writeMethod15(Boolean(entity.dropping));
        bb.writeMethod15(Boolean(entity.backpedal));
        return bb.toBuffer();
    }

    static isClientSpawnLevel(levelName: string): boolean {
        if (EntityHandler.usesServerAuthorityHostiles(levelName)) {
            return false;
        }

        return EntityHandler.usesClientSpawn(levelName);
    }

    private static pruneStaleServerNpcs(levelMap: Map<number, any>): number {
        let removedCount = 0;

        for (const [entityId, entityProps] of Array.from(levelMap.entries())) {
            if (entityProps?.isPlayer || entityProps?.clientSpawned) {
                continue;
            }

            levelMap.delete(entityId);
            removedCount++;
        }

        return removedCount;
    }

    private static getCraftTownTutorialState(client: Client) {
        if (client.currentLevel !== 'CraftTownTutorial') {
            return null;
        }

        if (!client.keepTutorialState) {
            client.keepTutorialState = createKeepTutorialState();
        }

        return client.keepTutorialState;
    }

    private static sendStartSkit(client: Client, entityId: number, dialogueId: number, missionId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod6(dialogueId, 3);
        bb.writeMethod4(missionId);
        MissionHandler.noteDungeonSkitActivity(client);
        client.sendBitBuffer(0x7B, bb);
    }

    private static sendRoomBossInfo(
        levelName: string,
        roomId: number,
        bossId: number,
        bossName: string,
        levelInstanceId: string = ''
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(Math.max(0, roomId));
        bb.writeMethod4(bossId);
        bb.writeMethod26(bossName);
        bb.writeMethod4(0);
        bb.writeMethod26('');
        const payload = bb.toBuffer();

        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);
        markRoomBossEntity(scopeKey, bossId, roomId, bossName);
        for (const other of GlobalState.getSessionsInLevelScope(scopeKey)) {
            if (!other.playerSpawned || getClientLevelScope(other) !== scopeKey) {
                continue;
            }
            other.send(0xAC, payload);
        }
        noteDungeonRunBossCutscene(scopeKey, roomId, bossId);
    }

    private static sendRoomSound(
        levelName: string,
        roomId: number,
        soundName: string,
        volume: number,
        levelInstanceId: string = ''
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(Math.max(0, roomId));
        bb.writeMethod13(soundName);
        bb.writeMethod4(Math.max(0, Math.min(100, Math.round(volume * 100))));
        const payload = bb.toBuffer();

        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);
        for (const other of GlobalState.getSessionsInLevelScope(scopeKey)) {
            if (!other.playerSpawned || getClientLevelScope(other) !== scopeKey) {
                continue;
            }
            other.send(0xA8, payload);
        }
    }

    private static sendNpcState(client: Client, entityId: number, entState: number, facingLeft: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(0);
        bb.writeMethod45(0);
        bb.writeMethod45(0);
        bb.writeMethod6(entState, 2);
        bb.writeMethod15(facingLeft);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        client.sendBitBuffer(0x07, bb);
    }

    static sendNpcMove(client: Client, entityId: number, dx: number, dy: number, state: number = 0, facingLeft: boolean = false): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(dx);
        bb.writeMethod45(dy);
        bb.writeMethod45(0); // deltaV
        bb.writeMethod6(state, 2);
        bb.writeMethod15(facingLeft);
        bb.writeMethod15(false); // running
        bb.writeMethod15(false); // jumping
        bb.writeMethod15(false); // dropping
        bb.writeMethod15(false); // backpedal
        bb.writeMethod15(false); // airborne
        client.sendBitBuffer(0x07, bb);
    }

    private static sendSetUntargetable(client: Client, entityId: number, untargetable: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod15(untargetable);
        client.sendBitBuffer(0xAE, bb);
    }

    private static sendDestroyEntity(client: Client, entityId: number): void {
        client.send(0x0D, EntityHandler.buildDestroyEntityPayload(entityId));
    }

    /**
     * The dead-state movement update that makes the client retire an entity by itself.
     *
     * `0x0D` alone is not enough and cannot be made enough from the server: the client's reader
     * only sets a flag on the entity's *brain*, so an entity without one is never removed
     * ([[client-ignores-destroy-for-brainless-entities]]) -- and the SWF patch that would fix
     * that crashes the client, twice over.
     *
     * This is the way through. The client's own 0x07 reader, on seeing an entity enter the dead
     * state, stamps `var_217` with the current tick. `Game.method_1970` then retires it through
     * the path it uses for its own corpses -- `if (!entity.method_1770()) { DestroyEntity(true);
     * entities.splice(i, 1); }`, where `method_1770` returns false once
     * `now - var_217 >= TIME_MONSTER_LAYS_DEAD_BEFORE_VANISHING`. Destroy *and* splice, in the
     * order the engine expects, with no patch at all.
     *
     * So every path that removes a shared hostile sends this first and the destroy second: the
     * destroy takes the entity away immediately for anything holding a brain, and this makes
     * the engine take away everything else a moment later.
     */
    static buildEntityStateDeadPayload(entityId: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(0);
        bb.writeMethod45(0);
        bb.writeMethod45(0);
        bb.writeMethod6(3, 2); // EntityState.DEAD = 3
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        return bb.toBuffer();
    }

    private static buildDestroyEntityPayload(entityId: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod15(true);
        return bb.toBuffer();
    }

    static broadcastDestroyEntity(
        levelName: string,
        entityId: number,
        excludedClient: Client | null = null,
        levelInstanceId: string = '',
        entityProps: any = null
    ): void {
        if (!levelName || entityId <= 0) {
            return;
        }

        const payload = EntityHandler.buildDestroyEntityPayload(entityId);
        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);
        const destroyedEntity = entityProps ?? EntityHandler.getLevelMap(levelName, levelInstanceId)?.get(entityId) ?? null;
        for (const other of GlobalState.getSessionsInLevelScope(scopeKey)) {
            if (
                other === excludedClient ||
                !other.playerSpawned ||
                getClientLevelScope(other) !== scopeKey ||
                other.socket?.destroyed
            ) {
                continue;
            }

            if (destroyedEntity && !destroyedEntity.isPlayer) {
                if (EntityHandler.shouldRelayEntityToOtherClients(levelName, destroyedEntity)) {
                    if (!EntityHandler.canClientSeeEntity(other, destroyedEntity)) {
                        continue;
                    }
                } else if (EntityHandler.shouldMirrorClientSpawnEntityToParty(levelName, destroyedEntity)) {
                    if (!EntityHandler.canClientUsePartySharedClientSpawnEntity(other, destroyedEntity)) {
                        continue;
                    }
                } else {
                    continue;
                }
            }

            other.knownEntityIds?.delete(entityId);
            other.send(0x0D, payload);
        }
    }

    private static getEquippedMountId(value: unknown): number {
        const mountId = Number(value ?? 0);
        return Number.isFinite(mountId) && mountId > 0 ? mountId : 0;
    }

    private static sendMountState(client: Client, entityId: number, mountId: number): void {
        if (entityId <= 0 || mountId <= 0) {
            return;
        }

        PetHandler.sendMountEquipPacket(client, entityId, mountId);
    }

    private static scheduleSelfMountSync(client: Client, entityId: number, mountId: number): void {
        if (entityId <= 0 || mountId <= 0) {
            return;
        }

        const levelScope = getClientLevelScope(client);
        const token = client.token;
        for (const delayMs of EntityHandler.MOUNT_SYNC_RETRY_DELAYS_MS) {
            setTimeout(() => {
                if (
                    !client.playerSpawned ||
                    getClientLevelScope(client) !== levelScope ||
                    client.token !== token ||
                    client.clientEntID !== entityId
                ) {
                    return;
                }

                EntityHandler.sendMountState(client, entityId, mountId);
            }, delayMs);
        }
    }

    private static scheduleExistingVisibleClientSpawnEntitiesToJoiner(joiner: Client): void {
        const levelScope = getClientLevelScope(joiner);
        const token = joiner.token;
        for (const delayMs of EntityHandler.CLIENT_SPAWN_JOINER_SEED_DELAYS_MS) {
            setTimeout(() => {
                if (!joiner.playerSpawned || getClientLevelScope(joiner) !== levelScope || joiner.token !== token) {
                    return;
                }

                EntityHandler.sendExistingVisibleClientSpawnEntitiesToJoiner(joiner);
            }, delayMs);
        }
    }

    /**
     * How far a spawn coordinate may sit above the real floor and still be placed cleanly.
     *
     * The client resolves an explicit spawn with
     *   getFloorCollision(0, x, y - 59, new Point(0, 160), ...)
     * -- a ray from 59px above the coordinate, running 160px down. Floor inside that band and
     * the body is snapped onto it with no visible movement; floor outside it and the client
     * leaves the body at the raw coordinate, which is the glide down to the ground players see
     * on entering a level. 59 is therefore the exact budget for error above the floor.
     */
    private static readonly SPAWN_SNAP_WINDOW_PX = 59;

    /**
     * Throw away a floor sample that the server's dead reckoning has drifted away from.
     *
     * entity.x/y is a running sum of movement deltas -- thinned by MovementAuthority
     * rejections and packet coalescing -- so it slowly parts company with where the player
     * actually is. The floor samples taken from it inherit that error, and once the error
     * exceeds the client's snap window the saved point stops being a place with floor under
     * it: a Jade City record reached y=-2526 with the ground at about 1050, which is a 3500px
     * fall on every login.
     *
     * A full update is the only packet carrying the client's absolute position, so it is the
     * one chance to notice. Beyond the snap window the inherited sample is a lie and the
     * absolute position replaces it -- for a standing packet through noteGroundedSample right
     * after this, and for an airborne one by leaving no sample at all rather than a wrong one.
     */
    private static discardDriftedGroundedSample(
        client: Client,
        props: any,
        previousEntity: any,
        absoluteX: number,
        absoluteY: number
    ): void {
        const reckonedX = Number(previousEntity?.x);
        const reckonedY = Number(previousEntity?.y);
        if (!Number.isFinite(reckonedX) || !Number.isFinite(reckonedY)) {
            return;
        }

        const driftX = Math.abs(reckonedX - Number(absoluteX));
        const driftY = Math.abs(reckonedY - Number(absoluteY));
        if (driftX <= EntityHandler.SPAWN_SNAP_WINDOW_PX && driftY <= EntityHandler.SPAWN_SNAP_WINDOW_PX) {
            return;
        }

        delete props.groundedX;
        delete props.groundedY;
        console.log(
            `[SpawnDrift] character=${String(client.character?.name ?? 'unknown')} ` +
            `level=${String(client.currentLevel ?? '')} reckoned=${Math.round(reckonedX)},${Math.round(reckonedY)} ` +
            `actual=${Math.round(Number(absoluteX))},${Math.round(Number(absoluteY))} ` +
            `drift=${Math.round(driftX)},${Math.round(driftY)} action=dropped_grounded_sample`
        );
    }

    private static buildPlayerSnapshot(client: Client): EntityProps | null {
        if (!client.character || !client.currentLevel) {
            return null;
        }

        const entityId = Number(client.clientEntID || 0);
        if (entityId <= 0) {
            return null;
        }

        const current = client.entities.get(entityId) ?? EntityHandler.getLevelMapForClient(client)?.get(entityId) ?? {};
        const playerEntity = Entity.fromCharacter(entityId, client.character, {
            ...current,
            roomId: client.currentRoomId
        });
        const persistedEntity = {
            ...current,
            ...playerEntity,
            clientSpawned: false,
            ownerToken: client.token || 0,
            ownerUserId: client.userId || 0,
            roomId: client.currentRoomId
        };

        client.entities.set(entityId, persistedEntity);
        EntityHandler.rememberEntityKnown(client, client.currentLevel, persistedEntity);
        let levelMap = EntityHandler.getLevelMapForClient(client);
        if (!levelMap) {
            levelMap = EntityHandler.getLevelMapForClient(client, true) ?? new Map<number, any>();
        }
        levelMap.set(entityId, persistedEntity);

        return playerEntity;
    }

    private static sendOtherPlayerMountToJoiner(joiner: Client, other: Client): void {
        if (!other.character || other.clientEntID <= 0) {
            return;
        }

        const mountId = EntityHandler.getEquippedMountId(other.character.equippedMount);
        EntityHandler.sendMountState(joiner, other.clientEntID, mountId);
    }

    private static broadcastPlayerMountState(client: Client, entityId: number, mountId: number): void {
        if (!client.currentLevel || mountId <= 0) {
            return;
        }

        for (const other of GlobalState.getSessionsInLevelScope(getClientLevelScope(client))) {
            if (other === client || !other.playerSpawned || !areClientsInSameLevelScope(client, other)) {
                continue;
            }

            EntityHandler.sendMountState(other, entityId, mountId);
        }
    }

    private static suppressCraftTownTutorialBoss(client: Client, entityId: number): void {
        client.entities.delete(entityId);
        EntityHandler.getLevelMapForClient(client)?.delete(entityId);
        EntityHandler.sendDestroyEntity(client, entityId);
    }

    private static handleCraftTownTutorialEntitySeen(client: Client, entityId: number, entityName: string, entity: any = null): void {
        const state = EntityHandler.getCraftTownTutorialState(client);
        if (!state) {
            return;
        }

        const dramaAnim = String(entity?.dramaAnim ?? entity?.DramaAnim ?? '');

        if (entityName === 'IntroParrot' && !state.introSkitSent) {
            EntityHandler.sendStartSkit(client, entityId, 0, 5);
            state.introSkitSent = true;
        }

        if (entityName === 'GoblinDagger' && dramaAnim === 'Board') {
            if (!EntityHandler.getCraftTownTutorialAuthoredHelperIds().has(entityId)) {
                return;
            }
            if (!state.helperEntityIds.includes(entityId)) {
                state.helperEntityIds.push(entityId);
            }
            return;
        }

        if (entityName !== 'GoblinShamanHood' && entityName !== 'IntroGoblinShamanHood') {
            return;
        }

        if (
            state.bossEntitySource === 'fallback' &&
            state.bossEntitySeen !== null &&
            state.bossEntitySeen !== entityId
        ) {
            EntityHandler.suppressCraftTownTutorialBoss(client, entityId);
            return;
        }

        if (entityName === 'GoblinShamanHood' && !state.bossIntroForced) {
            // The plain boss art should not be visible before the keep intro begins.
            EntityHandler.suppressCraftTownTutorialBoss(client, entityId);
            return;
        }

        state.bossEntitySeen = entityId;
        state.bossEntitySource = 'client';

        if (!state.bossInfoSentIds.has(entityId)) {
            EntityHandler.sendRoomBossInfo(
                client.currentLevel,
                client.currentRoomId,
                entityId,
                'Ranik, The Geomancer',
                client.levelInstanceId
            );
            state.bossInfoSentIds.add(entityId);
        }

        if (!state.bossMusicStarted) {
            EntityHandler.sendRoomSound(
                client.currentLevel,
                client.currentRoomId,
                'D02_MoodLoop_GoblinHideout',
                0.9,
                client.levelInstanceId
            );
            state.bossMusicStarted = true;
        }
    }
    
    // Server -> Client: Spawn Entity (Packet 0xF)
    static sendEntity(client: Client, entity: EntityProps | any): void {
        let props: EntityProps;
        
        if (entity.id && entity.entState !== undefined) {
             props = entity as EntityProps;
        } else {
             // Fallback for NpcDef or other objects
             props = Entity.fromNpc(entity);
        }
        
        const serializedProps = {
            ...props,
            // Flash treats nonzero spawn velocity as "hidden until first
            // movement update"; visible seed spawns avoid a join-time gfx race.
            v: 0
        };
        const data = Entity.serialize(serializedProps);
        client.send(0xF, data);
        EntityHandler.rememberEntityKnown(client, client.currentLevel, props);
        if (EntityHandler.isServerAuthorityHostileEntity(client.currentLevel, props)) {
            const entityId = Math.max(0, Math.round(Number(props.id ?? 0)));
            const localEntityId = EntityHandler.resolveEntityLocalId(client, entityId);
        }
    }

    // Deprecated: use sendEntity
    static sendNpc(client: Client, npc: NpcDef): void {
        this.sendEntity(client, npc);
    }

    static sendCraftTownAuthoredNpcs(client: Client): void {
        if (client.currentLevel !== 'CraftTown' || !client.playerSpawned) {
            return;
        }

        const levelMap = EntityHandler.getLevelMapForClient(client, true);
        if (!levelMap) {
            return;
        }

        const npcs = NpcLoader.getNpcsForLevel('CraftTown').filter((npc) => String(npc.name ?? '') === 'NPCHomeNeo');
        for (const npc of npcs) {
            const entityId = Math.max(0, Math.round(Number(npc.id) || 0));
            if (entityId <= 0 || client.knownEntityIds.has(entityId)) {
                continue;
            }

            let entityProps = levelMap.get(entityId);
            if (!entityProps) {
                entityProps = {
                    ...Entity.fromNpc(npc),
                    clientSpawned: false
                };
                levelMap.set(entityId, entityProps);
            }

            if (entityProps.isPlayer || entityProps.clientSpawned) {
                continue;
            }

            client.entities.set(entityId, { ...entityProps });
            EntityHandler.sendEntity(client, entityProps);
        }
    }

    /**
     * Spawns the keep garden statues for whoever just walked into a CraftTown instance.
     *
     * The line-up is always the one belonging to *this session's* keep owner - itself when you are
     * home, the host when you are visiting - and it is delivered **only to this session**.
     *
     * Statues are deliberately kept out of `GlobalState.levelEntities`. They carry fixed entity ids,
     * so two accounts' statues would occupy the same three ids; the moment anything put them in a
     * shared level map, an account could be shown another account's characters (which is exactly
     * what happens if two keeps ever resolve to the same level scope). Living only in
     * `client.entities` means no generic broadcast, joiner sync or map sweep can reach them, so a
     * session can never receive a set that is not its own. Props are rebuilt from the stored snapshot
     * on every send, so a statue re-dressed while nobody was watching still comes up correct.
     */
    static sendHomeStatues(client: Client): void {
        if (client.currentLevel !== HOME_STATUE_LEVEL || !client.playerSpawned) {
            return;
        }

        const owner = getCraftTownHomeOwnerCharacter(client.character, client.craftTownHostCharacter);
        const book = readHomeStatues(owner);

        for (const slot of HOME_STATUE_SLOTS) {
            const snapshot = book[slot.characterClass];
            if (!snapshot || client.knownEntityIds.has(slot.entityId)) {
                continue;
            }

            const entityProps = buildHomeStatueEntity(slot, snapshot);
            client.entities.set(slot.entityId, { ...entityProps });
            EntityHandler.sendEntity(client, entityProps);
        }
    }

    // 0x8
    static handleEntityFullUpdate(client: Client, data: Buffer): void {
        const br = new BitReader(data);

        const rawEntityId = br.readMethod9();
        // Keep garden statues are server-owned and per-session. Accepting a client update for one
        // would file it into the shared level map, which is the one way another account could end up
        // being shown someone else's statues.
        if (isHomeStatueEntityId(rawEntityId)) {
            return;
        }
        let entityId = rawEntityId;
        const posX = br.readMethod24();
        const posY = br.readMethod24();
        const velocityX = br.readMethod24();
        let entName = br.readMethod26();

        const team = br.readMethod20(Entity.TEAM_BITS);
        const isPlayer = br.readMethod15(); // bool
        const yOffset = br.readMethod706();

        // Optional Cue Data
        const hasCue = br.readMethod15();
        const cueData: any = {};
        if (hasCue) {
            if (br.readMethod15()) {
                cueData["character_name"] = br.readMethod13();
                // Comma-prefixed character_name overrides entity type for server identification
                const cname = String(cueData["character_name"] ?? '');
                if (cname.startsWith(',')) {
                    const overrideName = cname.substring(1);
                    if (overrideName) {
                        entName = overrideName;
                    }
                }
            }
            if (br.readMethod15()) {
                cueData["DramaAnim"] = br.readMethod13();
            }
            if (br.readMethod15()) {
                cueData["SleepAnim"] = br.readMethod13();
            }
        }

        const hasSummoner = br.readMethod15();
        let summonerId = 0;
        if (hasSummoner) {
            summonerId = br.readMethod9();
        }

        const hasPower = br.readMethod15();
        let powerId = 0;
        if (hasPower) {
            powerId = br.readMethod9();
        }

        const entState = br.readMethod20(Entity.STATE_BITS);

        const bLeft = br.readMethod15();
        const bRunning = br.readMethod15();
        const bJumping = br.readMethod15();
        const bDropping = br.readMethod15();
        const bBackpedal = br.readMethod15();

        const levelName = LevelConfig.normalizeLevelName(client.currentLevel) || client.currentLevel;
        if (levelName) {
            EntityHandler.ensureJcMini1PartySharedScope(client, levelName, 'entity_full_update');
        }
        const existingLevelMap = levelName ? EntityHandler.getLevelMap(levelName, client.levelInstanceId) : null;

        const entNameNorm = EntityHandler.normalizeIdentityName(entName);
        const charNameNorm = EntityHandler.normalizeIdentityName(client.character?.name);
        const isSelfPacket = Boolean(isPlayer && entNameNorm && charNameNorm && entNameNorm === charNameNorm);

        if (isPlayer && levelName && isSelfPacket) {
            const levelScope = getClientLevelScope(client);
            const canonicalEntityId = EntityHandler.allocateCanonicalPlayerEntityId(client, levelScope, rawEntityId);
            // The new id is adopted BEFORE the alias is recorded, and the order matters.
            //
            // This is the one legitimate "alias my own body" case: the id the client calls
            // itself collided with another session's, so the server renames it and has to be
            // able to translate the client's own number forward. `rememberEntityAlias` refuses a
            // key equal to `client.clientEntID` -- and until this assignment moved up, that was
            // still the OLD id, so the refusal ate exactly the alias that makes the rename work
            // and every later packet from that client arrived under an id nothing could resolve.
            entityId = canonicalEntityId;
            client.clientEntID = canonicalEntityId;
            if (canonicalEntityId !== rawEntityId) {
                EntityHandler.rememberEntityAlias(client, rawEntityId, canonicalEntityId);
                EntityHandler.migrateOwnedPlayerEntityId(client, existingLevelMap, rawEntityId, canonicalEntityId);
            }
        } else if (isPlayer && client.clientEntID === 0) {
            client.clientEntID = entityId;
        }

        const ownsThisPlayerPacket = Boolean(
            isPlayer &&
            client.character &&
            (isSelfPacket || (client.clientEntID > 0 && client.clientEntID === entityId))
        );

        const props: EntityProps & {
            clientSpawned?: boolean;
            ownerToken?: number;
            ownerUserId?: number;
            ownerPartyId?: number;
        } = ownsThisPlayerPacket
            ? {
                ...Entity.fromCharacter(entityId, client.character!, {
                    x: posX,
                    y: posY,
                    v: velocityX,
                team,
                entState,
                facingLeft: bLeft,
                running: bRunning,
                jumping: bJumping,
                dropping: bDropping,
                backpedal: bBackpedal,
                renderDepthOffset: yOffset,
                roomId: client.currentRoomId
                }),
                characterName: cueData.character_name,
                dramaAnim: cueData.DramaAnim,
                sleepAnim: cueData.SleepAnim,
                summonerId,
                powerId,
                running: bRunning,
                jumping: bJumping,
                dropping: bDropping,
                backpedal: bBackpedal,
                clientSpawned: false,
                ownerToken: client.token || 0,
                ownerUserId: client.userId || 0,
                ownerCharacterName: client.character?.name || '',
                ownerPartyId: getPartyIdForClient(client),
                roomId: client.currentRoomId
            }
            : {
                id: entityId,
                name: entName,
                isPlayer: isPlayer,
                x: posX,
                y: posY,
                v: velocityX,
                team: team,
                renderDepthOffset: yOffset,
                characterName: cueData.character_name,
                dramaAnim: cueData.DramaAnim,
                sleepAnim: cueData.SleepAnim,
                summonerId: summonerId,
                powerId: powerId,
                entState: entState,
                facingLeft: bLeft,
                running: bRunning,
                jumping: bJumping,
                dropping: bDropping,
                backpedal: bBackpedal,
                clientSpawned: !isPlayer,
                ownerToken: client.token || 0,
                ownerUserId: client.userId || 0,
                ownerCharacterName: client.character?.name || '',
                ownerPartyId: getPartyIdForClient(client),
                roomId: client.currentRoomId
                // bRunning etc are flags
            };

        EntityHandler.applyRuntimeDungeonEntityLevel(client, levelName, props);

        // A full update replaces the entity object wholesale, which used to throw away the
        // floor sample the incremental packets had built up. Everything that places a body
        // (level entry, the login restore, the transfer save, party anchor spawns) reads that
        // sample, so losing it here left those paths falling back to a live position that can
        // be in open air -- and this packet's own flags were never consulted, so a full update
        // sent mid-jump looked perfectly grounded.
        if (isPlayer) {
            const previousEntity = client.entities.get(entityId)
                ?? client.entities.get(rawEntityId)
                ?? existingLevelMap?.get(entityId);
            inheritGroundedSample(props, previousEntity);
            // A sample the entity carried in from the level it just left is not floor here.
            // The inherit above is what makes it survive the level change at all, so this is
            // the one place that can tell the difference.
            discardForeignGroundedSample(props, levelName);
            EntityHandler.discardDriftedGroundedSample(client, props, previousEntity, posX, posY);
            // The client sends its true absolute position here, so a standing full update is
            // the most trustworthy floor sample there is -- including the one that arrives on
            // spawn, which is what gives a player who leaves immediately a point to return to.
            const standing = !bJumping && !bDropping;
            noteGroundedSample(props, posX, posY, !standing, levelName, true);

            /**
             * ...and it is the only coordinate that may ever be replayed as a spawn point.
             *
             * Every other position the server holds is `entity.x/y`: a sum of movement deltas
             * on top of whatever the server *believed* the last spawn point was. When the
             * client disagreed with that belief -- snapping the body up to 160px onto floor,
             * or letting it fall because there was no floor inside its snap window -- it
             * corrected itself with no delta to say so, and the offset was inherited by every
             * later sample, saved, and handed back as the next spawn. That is the loop that
             * put players in the air on entry, and it compounds: each visit falls from the
             * error the last one left behind, which is how a live CraftTown record reached
             * y=-349 with the floor at 1460.
             *
             * This packet is the client telling the server where it actually is, while telling
             * it that it is standing. Recording it here, and reading nothing else at spawn
             * time (LevelConfig.getConfirmedSpawnForLevel), closes the loop: the worst case
             * becomes "no confirmed point yet, use the level's authored spawn", which is floor
             * by construction.
             */
            if (ownsThisPlayerPacket && standing && client.character) {
                LevelConfig.rememberConfirmedSpawn(client.character, levelName, posX, posY);
            }
        }

        if (!isPlayer) {
            client.clientSpawnConfirmed = true;
            clearClientSpawnFallbackTimer(client);
            if (client.currentLevel === 'CraftTownTutorial') {
                EntityHandler.handleCraftTownTutorialEntitySeen(client, entityId, String(props.name ?? ''), props);
            }
        }

        let levelMap = existingLevelMap;
        if (levelName) {
            if (!levelMap) {
                levelMap = EntityHandler.getLevelMapForClient(client, true) ?? new Map<number, any>();
            }
        }

        const tutorialAuthority = TutorialDungeonMechanics.isTutorialDungeon(levelName)
            ? TutorialDungeonMechanics.tagClientObject(props, Number(client.currentRoomId ?? 0))
            : null;
        if (tutorialAuthority && tutorialAuthority.role !== 'boss') {
            client.entities.set(rawEntityId, props);
            if (EntityHandler.applyTutorialDungeonWorldSnapshotToLocalObject(client, props, rawEntityId)) {
                return;
            }
            noteDungeonRunEntitySeen(client, rawEntityId, props);
            EntityHandler.rememberEntityKnown(client, levelName, props);
            return;
        }

        // Every non-player, non-hostile object a client spawns in a shared dungeon.
        //
        // Chests are next on the list and nothing in the hostile machinery covers them: they
        // are not enemies, so they have no canonical, no binding and no death to relay. Before
        // designing that, the one thing worth knowing is how a chest actually reaches the
        // server -- what name it carries, what team it claims, whether it has a health pool at
        // all -- because every wrong guess this session came from designing before measuring.
        if (
            !isPlayer &&
            Number(props?.team ?? 0) !== EntityTeam.ENEMY &&
            EntityHandler.usesServerAuthorityHostiles(levelName)
        ) {
            console.log(
                `[ClientObject] ${levelName} -> ${String(client.character?.name ?? '?')} ` +
                `id=${rawEntityId} name=${String(props?.name ?? '?')} team=${Number(props?.team ?? 0)} ` +
                `hp=${Math.round(Number((props as any)?.hp ?? 0))}/${Math.round(Number((props as any)?.maxHp ?? 0))} ` +
                `room=${Number(props?.roomId ?? -1)} state=${Number(props?.entState ?? -1)}`
            );
        }
        // A chest the run has already opened is broken the moment this client spawns it.
        //
        // This is what a joiner walks into: their client plays the room's cues and puts an
        // unbroken chest in front of them, hours after somebody emptied it. Nothing else can
        // catch it -- chests are not in the roster, so none of the hostile paths ever see one.
        if (!isPlayer && EntityHandler.isChestEntity(props)) {
            const chestScope = getClientLevelScope(client);
            const chestX = Number((props as any)?.x ?? NaN);
            const chestY = Number((props as any)?.y ?? NaN);
            const alreadyOpen = EntityHandler.isChestOpened(chestScope, chestX, chestY);
            EntityHandler.noteChestSpawnPosition(client, chestScope, rawEntityId, chestX, chestY);
            console.log(
                `[Chest] ${String(client.character?.name ?? '?')} spawned ${String(props?.name ?? '?')} ` +
                `id=${rawEntityId} at ${Math.round(chestX)},${Math.round(chestY)} opened=${alreadyOpen}`
            );
            if (alreadyOpen) {
                EntityHandler.sendChestBreak(client, rawEntityId, props);
                return;
            }
        }
        if (EntityHandler.suppressServerAuthorityClientHostileSpawn(client, levelName, props, rawEntityId)) {
            return;
        }

        if (EntityHandler.normalizeHybridClientSpawnHostileCanonical(client, levelName, levelMap, props, rawEntityId)) {
            return;
        }

        if (EntityHandler.suppressFollowerLeaderAuthoritativeDungeonSpawn(client, levelName, levelMap, props)) {
            return;
        }

        if (EntityHandler.suppressDuplicateSharedClientSpawn(client, levelName, levelMap, props)) {
            return;
        }

        if (EntityHandler.suppressLateDuplicateRoomBossSpawn(client, levelName, levelMap, props, entityId)) {
            return;
        }

        client.entities.set(entityId, props);
        if (ownsThisPlayerPacket) {
            MovementAuthority.reset(client, 'entity_full_update_self', props.x, props.y);
            if (Number(props.entState ?? EntityState.ACTIVE) !== EntityState.DEAD && !Boolean((props as any).dead)) {
                const { CombatHandler } = require('./CombatHandler') as typeof import('./CombatHandler');
                CombatHandler.notePlayerActiveMovementState(client, Date.now(), true);
            }
        }
        if (
            !isPlayer &&
            EntityHandler.applyTutorialDungeonWorldSnapshotToLocalObject(client, props, rawEntityId)
        ) {
            return;
        }
        noteDungeonRunEntitySeen(client, entityId, props);
        EntityHandler.rememberEntityKnown(client, levelName, props);

        // Client-private dungeon hostiles remain local to their authored client.
        // They must never become canonical server state when a party is created.
        const privateDungeonHostile = EntityHandler.isPrivateClientSpawnDungeonHostile(levelName, props);
        if (levelMap && !privateDungeonHostile) {
            levelMap.set(entityId, props);
        }

        if (!privateDungeonHostile) {
            // Broadcast the normalized snapshot so remote clients receive canonical state.
            EntityHandler.broadcastToLevel(client, EntityHandler.buildEntityFullUpdatePayload(props), props);
        }

        if (isPlayer && !client.playerSpawned) {
             client.playerSpawned = true;
             client.mountTransferGraceUntil = Math.max(client.mountTransferGraceUntil, Date.now() + 4000);
             // Opened before anything draws this body. The effect rides along with each
             // viewer's copy as it is sent, and `sendExistingPlayersToJoiner` below is the send
             // that reaches everyone already standing in the level.
             //
             // Read from the character-keyed map, not from this session: the socket that
             // handled the transfer request has already been closed and this is a third
             // connection with a token of its own. See GlobalState.pendingArrivalEffects.
             client.partyArrivalEffectPending = false;
             const { SocialHandler } = require('./SocialHandler') as typeof import('./SocialHandler');
             const isPartyArrival = SocialHandler.consumePartyArrivalEffect(client);
             if (isPartyArrival) {
                 console.log(`[PartyArrival] armed spawn for ${String(client.character?.name ?? '?')} in ${client.currentLevel}`);
                 EntityHandler.beginPartyArrivalEffectWindow(client);
             }
             const equippedMountId = EntityHandler.getEquippedMountId(
                client.character?.equippedMount ?? props.equippedMount ?? 0
            );
             EntityHandler.scheduleSelfMountSync(client, client.clientEntID, equippedMountId);
             EntityHandler.sendExistingPlayersToJoiner(client);
             EntityHandler.broadcastPlayerSpawn(client, props);
             EntityHandler.broadcastPlayerMountState(client, props.id, equippedMountId);
             BuildingHandler.refreshCraftTownBuildingsOnSpawn(client);
             EntityHandler.sendCraftTownAuthoredNpcs(client);
             HomeStatueHandler.onCraftTownSpawn(client);
             // Deliberately nothing for the traveller's own screen. The effect is what the
             // party sees when someone materialises next to them; on the arriving player's own
             // screen it would play under the level's name card at best, and as a flash over
             // their own character at worst. `sendPlayerBodyToViewer` never draws a player to
             // themselves, so the per-viewer hook already leaves them out -- this is only a
             // note that the omission is the design, not a gap.
        } else if (isPlayer) {
            // Standing invariant, not an event. The seed and its two retries all happen in the
            // first three seconds of a spawn, and a body lost after that -- by a late teardown,
            // a dropped packet, a spawn that landed while the level was still loading -- used
            // to stay lost for the whole run. This runs off the player's own movement, only
            // draws what the viewer is not already holding, and is throttled, so a scope where
            // everyone can see everyone does nothing at all.
            EntityHandler.reconcilePlayerVisibilityOnActivity(client);
        }
    }

    // Short, because until this runs a party member is standing in the wrong room on somebody
    // else's screen. It is only a walk over the sessions in one scope plus two map lookups per
    // pair, and it sends nothing at all unless a screen is actually wrong.
    private static readonly PLAYER_VISIBILITY_RECONCILE_INTERVAL_MS = 500;
    private static readonly playerVisibilityReconciledAt = new Map<number, number>();

    static reconcilePlayerVisibilityOnActivity(client: Client): void {
        const token = Math.max(0, Math.round(Number(client.token ?? 0)));
        if (token <= 0) {
            return;
        }

        const now = Date.now();
        const last = EntityHandler.playerVisibilityReconciledAt.get(token) ?? 0;
        if (now - last < EntityHandler.PLAYER_VISIBILITY_RECONCILE_INTERVAL_MS) {
            return;
        }

        EntityHandler.playerVisibilityReconciledAt.set(token, now);
        EntityHandler.reconcilePlayerVisibilityInScope(client);
    }

    static sendInitialLevelEntities(client: Client, levelName: string): void {
        levelName = LevelConfig.normalizeLevelName(levelName) || levelName;
        EntityHandler.ensureJcMini1PartySharedScope(client, levelName, 'send_initial_level_entities');
        console.log(`[EntityHandler] Sending initial entities for ${levelName} to ${client.character?.name}`);

        EntityHandler.resetFinishedDungeonRunScope(client, levelName);

        // Settle the run's tier before anything in this level is built. The NPC pass below
        // creates hostiles directly rather than through `seedServerAuthorityHostiles`, so
        // settling only there left the first hostiles sized at the authored tier and the tier
        // rising later -- mid-fight -- when something else happened to resolve it.
        if (EntityHandler.usesServerAuthorityHostiles(levelName)) {
            EntityHandler.resolveServerAuthorityEntityLevel(getClientLevelScope(client));
        }

        let levelMap = EntityHandler.getLevelMap(levelName, client.levelInstanceId);
        if (!levelMap) {
            levelMap = EntityHandler.getLevelMap(levelName, client.levelInstanceId, true) ?? new Map<number, any>();

            if (EntityHandler.usesClientSpawn(levelName)) {
                console.log(`[EntityHandler] Skipping server NPC init for client-spawn level ${levelName}`);
            } else {
                const npcs = NpcLoader.getNpcsForLevel(levelName);
                console.log(`[EntityHandler] Initializing ${npcs.length} NPCs for ${levelName}`);

                for (const npc of npcs) {
                    const entityProps = EntityHandler.usesServerAuthorityHostiles(levelName)
                        ? EntityHandler.createServerAuthorityEntityFromNpc(client, levelName, npc)
                        : {
                            ...Entity.fromNpc(npc),
                            clientSpawned: false
                    };
                    EntityHandler.applyRuntimeDungeonEntityLevel(client, levelName, entityProps);
                    levelMap.set(npc.id, entityProps);
                }
            }
        }

        if (EntityHandler.usesServerAuthorityHostiles(levelName)) {
            EntityHandler.resetServerAuthorityScopeForFreshRun(client, levelName, levelMap);
            EntityHandler.seedServerAuthorityHostiles(client, levelName, levelMap);
        }

        const clientSpawnLevel = EntityHandler.usesClientSpawn(levelName);
        const serverAuthorityHostiles = EntityHandler.usesServerAuthorityHostiles(levelName);
        const canonicalVisibleServerAuthority = EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelName);
        if (clientSpawnLevel) {
            const removedCount = EntityHandler.pruneStaleServerNpcs(levelMap);
            if (removedCount > 0) {
                console.log(
                    `[EntityHandler] Removed ${removedCount} stale server NPCs from client-spawn level ${levelName}`
                );
            }
            if (!serverAuthorityHostiles) {
                return;
            }
        }

        for (const [id, entityProps] of levelMap.entries()) {
            if (id === client.clientEntID) continue;
            if (entityProps?.isPlayer) continue;
            if (EntityHandler.isEntityDead(entityProps)) continue;
            if (entityProps?.clientSpawned) continue;
            if ((entityProps as any)?.serverOnlyObjective) continue;
            EntityHandler.normalizeServerAuthorityHostileState(levelName, entityProps);
            if (EntityHandler.isServerAuthorityHostileEntity(levelName, entityProps)) {
                noteDungeonRunEntitySeen(client, id, entityProps);
                const canonicalDead = Boolean((entityProps as any).dead) ||
                    Number(entityProps.entState ?? EntityState.ACTIVE) === EntityState.DEAD;
                if (!canonicalVisibleServerAuthority || canonicalDead) {
                    continue;
                }
                // The room boss stays client-spawned. Its room drives the whole encounter
                // through the am_Boss cue -- Defeated(), AddBuff, Skit, the two cutscenes --
                // so the client must keep drawing it, and the level SWF's cue suppression
                // skips it for the same reason. Sending it here would draw it twice:
                // LinkUpdater.method_1828 only merges duplicates that both carry the REMOTE
                // flag, so a client-spawned copy is never deduped against a server-sent one.
                if (EntityHandler.isCanonicalRoomBossEntity(entityProps)) {
                    continue;
                }
                client.entities.set(id, { ...entityProps });
                EntityHandler.sendEntity(client, entityProps);
                continue;
            }
            client.entities.set(id, { ...entityProps });
            noteDungeonRunEntitySeen(client, id, entityProps);
            EntityHandler.sendEntity(client, entityProps);
        }
        EntityHandler.sendTutorialDungeonWorldSnapshot(client, 'initial_entities_ready');
        MissionHandler.tryRestoreDungeonCompletionAfterReentry(client);
    }

    /**
     * The session that owns this character *now*, when it is not the one being torn down.
     *
     * A door is two connections: the old socket closes and the client immediately opens a
     * new one, and the close handler is not guaranteed to run first. When it runs second it
     * used to tear down the body the successor had already spawned -- `removeOwnedEntities`
     * matches player bodies by character name, and the name is the same on both sides of
     * the door. The destroy went to everyone *except* the departing client, so the player
     * who walked through the door became permanently invisible to the rest of the party
     * while still seeing them: the reported "we used the door and can no longer see each
     * other even though we are standing in the same place".
     */
    private static resolveLiveSuccessorSession(client: Client): Client | null {
        const characterName = client.character?.name;
        if (!characterName) {
            return null;
        }

        const owner = GlobalState.getActiveSessionByCharacterName(characterName);
        return owner && owner !== client && GlobalState.isClientConnectionOpen(owner) ? owner : null;
    }

    static removeOwnedEntities(client: Client): number[] {
        const levelName = client.currentLevel;
        if (!levelName) {
            return [];
        }

        const removedEntityIds = new Set<number>();
        const removedEntityProps = new Map<number, any>();
        const levelMap = EntityHandler.getLevelMap(levelName, client.levelInstanceId);
        const charNameNorm = EntityHandler.normalizeIdentityName(client.character?.name);
        const successor = EntityHandler.resolveLiveSuccessorSession(client);
        const successorEntityId = Math.max(0, Math.round(Number(successor?.clientEntID ?? 0)));

        if (levelMap) {
            for (const [entityId, entityProps] of Array.from(levelMap.entries())) {
                // The successor's body is not this session's to remove, whatever the name
                // on it says.
                if (successorEntityId > 0 && entityId === successorEntityId) {
                    continue;
                }

                const entityNameNorm = EntityHandler.normalizeIdentityName(entityProps?.name);
                const isOwnedPlayer = Boolean(entityProps?.isPlayer) && (
                    (client.clientEntID > 0 && entityId === client.clientEntID) ||
                    // Matching by name is what catches a body left behind under an id this
                    // session no longer remembers. It may only be trusted while nobody else
                    // is playing that character.
                    (!successor && charNameNorm && entityNameNorm === charNameNorm)
                );
                const isOwnedClientSpawn =
                    Boolean(entityProps?.clientSpawned) &&
                    Number(entityProps?.ownerToken ?? 0) === client.token &&
                    (!successor || Number(entityProps?.ownerToken ?? 0) !== successor.token) &&
                    !EntityHandler.isServerAuthorityHostileEntity(levelName, entityProps);

                if (isOwnedPlayer || isOwnedClientSpawn) {
                    levelMap.delete(entityId);
                    removedEntityIds.add(entityId);
                    removedEntityProps.set(entityId, entityProps);
                }
            }

            if (levelMap.size === 0) {
                GlobalState.levelEntities.delete(getClientLevelScope(client));
            }
        }

        if (client.playerSpawned && client.clientEntID > 0 && client.clientEntID !== successorEntityId) {
            removedEntityIds.add(client.clientEntID);
        }

        for (const entityId of removedEntityIds) {
            EntityHandler.broadcastDestroyEntity(
                levelName,
                entityId,
                client,
                client.levelInstanceId,
                removedEntityProps.get(entityId)
            );
        }

        return Array.from(removedEntityIds);
    }

    /**
     * Who else is standing in this scope, resolved from live sessions.
     *
     * Player visibility is the one thing that must never depend on an index being in
     * step: a session missing from `sessionsByLevelScope` for even one spawn is a party
     * member who is never sent, and nothing sends them again for the rest of the run --
     * the reported "we walked through a door and now only one of us can see the other".
     * These paths run on spawn and on gear/snapshot changes, not per frame, so the scan
     * is affordable.
     */
    /**
     * `ProcPartyArrival` (added to Game.swz by `scripts/patch_gameswz_party_arrival_effect.ts`):
     * `a_TeleportEffect` from SFX_1, a white-blue column of water that rises into a body and
     * breaks into sparks, plus `snd_pwr_aoe_fire`.
     *
     * It has to be the `Proc` copy rather than the stock `TeleportEffect` (2078) it was cloned
     * from, and the reason is in the client's cast reader, not in the data. For a `Proc` power
     * (`var_301`, set from the name prefix) the reader **casts it there and then** --
     * `new ActivePower(...); method_243(); method_129();`. For anything else it only *stores*
     * the ActivePower in `combatState.mActivePower` and leaves it for the entity's own update
     * loop to start. On a freshly spawned remote body that loop does not pick it up, and 2078
     * produced no sound and no graphic at all when it was tried here -- while the same 2078
     * plays perfectly when cast on your own body through `fx:`, because there the local update
     * loop does run it.
     */
    private static readonly PARTY_ARRIVAL_EFFECT_POWER_ID = 4017;

    /**
     * Default delay for the scope-wide send below, which is now only the `fx:` debug command --
     * the arrival itself hands the effect to each viewer as their copy of the body goes out,
     * so it never has to guess at a delay.
     */
    private static readonly PARTY_ARRIVAL_EFFECT_DELAY_MS = 0;

    /**
     * Play the "go to" materialisation on every screen that can see the traveller, their own
     * included.
     *
     * Player entity ids are not aliased per viewer -- every client refers to a player by the
     * same `clientEntID`, and a client's own body carries that id too -- so one payload serves
     * the whole scope.
     *
     * Only `fx:` uses this now; a real arrival goes through the per-viewer path below.
     */

    /**
     * How long an arrival keeps handing its effect to newly-drawn viewers. Long enough to cover
     * a party member who is still loading the level, or one whose copy of the body was refused
     * a few times for reading as airborne, and short enough that an ordinary redraw minutes
     * later is just a redraw.
     */
    private static readonly ARRIVAL_EFFECT_WINDOW_MS = 8000;

    /** Start the per-viewer window. Called once, on the spawn a `Go to` was armed for. */
    static beginPartyArrivalEffectWindow(client: Client): void {
        client.arrivalEffectWindowUntil = Date.now() + EntityHandler.ARRIVAL_EFFECT_WINDOW_MS;
        client.arrivalEffectSentToTokens.clear();
    }

    /**
     * How long to wait, after a viewer is handed the body, before casting the effect on it.
     *
     * Arriving in the same tick as the spawn is not enough. `ActivePower.method_750` places the
     * graphic with `playerEntLayer.getChildIndex(entity.gfx.m_TheDO)`, which throws when that
     * display object is not in the layer yet -- and a body the client built microseconds ago is
     * exactly that. The throw is swallowed by `method_1507`'s own try/catch, so the cast's
     * *sound* plays and its graphic silently never appears: the "efekt sesi duyuluyor ama
     * görsel gösterilmiyor" report, precisely.
     *
     * A few frames is all it takes. This is short enough to still read as the arrival itself.
     */
    private static readonly ARRIVAL_EFFECT_DRAW_DELAY_MS = 700;

    /**
     * Play the arrival effect for one viewer, the first time that viewer is handed the body.
     *
     * Scheduled from the moment the body goes out, so the cast can never overtake the spawn it
     * belongs to -- the client would drop it on `GetEntFromID`.
     */
    private static playArrivalEffectForViewer(viewer: Client, subject: Client): void {
        // Written so an unarmed subject leaves without touching the set: `windowUntil` is
        // undefined on the stub clients the regression tests hand this path, and `Date.now() >
        // undefined` is false, not true.
        const windowUntil = Number(subject.arrivalEffectWindowUntil ?? 0);
        if (!(Date.now() <= windowUntil) || subject.arrivalEffectSentToTokens?.has(viewer.token)) {
            return;
        }

        subject.arrivalEffectSentToTokens?.add(viewer.token);
        const viewerToken = viewer.token;
        const entityId = subject.clientEntID;
        setTimeout(() => {
            if (!viewer.playerSpawned || viewer.token !== viewerToken || !viewer.knownEntityIds.has(entityId)) {
                return;
            }

            viewer.send(0x09, EntityHandler.buildArrivalEffectPayload(entityId));
            console.log(
                `[PartyArrival] effect drawn on ${String(viewer.character?.name ?? '?')}'s screen ` +
                `for ${String(subject.character?.name ?? '?')} ent=${entityId}`
            );
        }, EntityHandler.ARRIVAL_EFFECT_DRAW_DELAY_MS).unref?.();
    }

    private static buildArrivalEffectPayload(entityId: number, powerId?: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod4(Math.max(1, Math.round(Number(powerId ?? EntityHandler.PARTY_ARRIVAL_EFFECT_POWER_ID))));
        bb.writeMethod15(false); // hasTargetEntity
        bb.writeMethod15(false); // hasTargetPos
        bb.writeMethod15(false); // hasProjectile
        bb.writeMethod15(false); // isPersistent
        bb.writeMethod15(false); // hasComboData
        bb.writeMethod15(false); // hasPowerResourceData
        return bb.toBuffer();
    }

    static playPartyArrivalEffect(client: Client, delayMs?: number, powerIdOverride?: number): void {
        const entityId = Math.max(0, Math.round(Number(client.clientEntID) || 0));
        const token = client.token;
        const powerId = Math.max(1, Math.round(Number(powerIdOverride ?? EntityHandler.PARTY_ARRIVAL_EFFECT_POWER_ID)));
        if (entityId <= 0) {
            console.log(`[PartyArrival] skipped ${String(client.character?.name ?? '?')}: no entity id yet`);
            return;
        }

        setTimeout(() => {
            if (!client.playerSpawned || client.token !== token || client.clientEntID !== entityId) {
                console.log(`[PartyArrival] skipped ${String(client.character?.name ?? '?')}: session moved on`);
                return;
            }

            const levelScope = getClientLevelScope(client);
            if (!levelScope) {
                console.log(`[PartyArrival] skipped ${String(client.character?.name ?? '?')}: no level scope`);
                return;
            }

            const payload = EntityHandler.buildArrivalEffectPayload(entityId, powerId);

            // Sent to the whole scope without consulting knownEntityIds: that set records
            // that a body was *offered* to a viewer, not that the viewer drew it
            // ([[known-entity-id-is-not-proof-a-body-was-drawn]]), and a viewer who really
            // does not hold the entity drops this packet on its own `GetEntFromID`. Skipping
            // one is a missed effect; sending one too many costs nothing.
            let viewers = 0;
            for (const viewer of EntityHandler.getSpawnedSessionsInScope(levelScope)) {
                viewer.send(0x09, payload);
                viewers += 1;
            }
            console.log(
                `[PartyArrival] cast power=${powerId} on ${String(client.character?.name ?? '?')} ` +
                `ent=${entityId} scope=${levelScope} viewers=${viewers} bytes=${payload.length}`
            );
        }, Math.max(0, Math.round(Number(delayMs ?? EntityHandler.PARTY_ARRIVAL_EFFECT_DELAY_MS)))).unref?.();
    }

    private static getSpawnedSessionsInScope(levelScope: string): Client[] {
        if (!levelScope) {
            return [];
        }

        const sessions: Client[] = [];
        for (const session of GlobalState.sessionsByToken.values()) {
            if (session.playerSpawned && getClientLevelScope(session) === levelScope) {
                sessions.push(session);
            }
        }
        return sessions;
    }

    /**
     * A player body about to be drawn on somebody else's screen, placed on floor.
     *
     * Seeding another client with a player is a spawn, and the client only snaps a spawn
     * onto floor within 160px of where the server put it (see the note at the top of
     * core/GroundedPosition). Handing it the live sample means handing it whatever the
     * movement deltas add up to right now -- mid-jump, mid-knockback, or mid-boss-intro
     * where the scripted camera work leaves the body well above the ground. Outside the
     * snap window the client accepts the point and lets the body fall to the floor, which
     * is the party members raining down at the start of the boss scene.
     *
     * The live position still wins whenever it is itself the standing sample; the grounded
     * fallback only replaces a point the client never claimed to be standing on. Movement
     * packets correct any small difference on the next frame.
     */
    private static withGroundedBodyPosition(entity: any, levelName: string | null | undefined): any | null {
        if (!entity) {
            return entity;
        }

        // The last position this body's own client reported standing at, absolute or not.
        //
        // Demanding an absolute was what made an arrival bounce. The client sends one only from
        // the `Entity` constructor, so a player who is mid-drop at that instant -- which is
        // every arrival that does not land dead on the floor -- has no absolute sample at all.
        // Every pass then refused the placement, and after three refusals the fallback below
        // drew the body at its live, airborne point: the party member watched them appear in
        // the air and fall, once per pass, which is the "it jumps two or three times on entry"
        // report. A standing 0x07 arrives within a frame of landing and is a floor point in
        // this same level, so the body is drawn on the ground the first time and the later
        // passes re-place it exactly where it already is -- inside the client's snap band,
        // which resolves with no visible movement. See
        // LevelHandler.resolveStandingAnchorPosition for why a live same-level sample tracks
        // the client rather than drifting from it.
        const grounded = isEntityAirborne(entity)
            ? resolveConfirmedGroundedPosition(entity, levelName)
            : resolveGroundedPosition(entity, levelName) ?? resolveConfirmedGroundedPosition(entity, levelName);
        if (!grounded) {
            // No confirmed floor sample. If the body is airborne on top of that there is
            // nothing safe to draw it at: the live point is somewhere in open air, and the
            // client accepts it as given once it is outside the snap ray, which is the
            // player materialising above the boss room and gliding down. Refuse the seed and
            // let the resync pass send it once the client reports standing somewhere.
            return isEntityAirborne(entity) ? null : entity;
        }

        const liveX = Math.round(Number(entity.x ?? NaN));
        const liveY = Math.round(Number(entity.y ?? NaN));
        if (liveX === grounded.x && liveY === grounded.y) {
            return entity;
        }

        return { ...entity, x: grounded.x, y: grounded.y };
    }

    /**
     * Draw one player on one other player's screen.
     *
     * Returns false when there is nothing safe to send yet. A body with no position would go
     * out as 0,0 -- the world origin -- so a subject whose own client has not reported a
     * position is skipped and left to the resync pass below rather than teleported.
     */
    /**
     * Is this screen's copy of that player wrong?
     *
     * The client has no reader for the 0x08 full update, so a body is only ever placed by a
     * 0x0F spawn and only ever moved within a room by relayed 0x07 deltas. That leaves three
     * ways a screen can be wrong, and `knownEntityIds` alone recognises just one of them.
     *
     * The third is the one that produced the last live report -- the dungeon starter visible to
     * nobody who joined them. `ensureEntityKnown`, on the relay path, pulls a body in by
     * sending the raw level-map snapshot and marks the id known. If that copy never actually
     * landed (it is seeded with no floor treatment, and it arrives whenever a relay happens to
     * run, including while the joining client is still loading its level), the id is known and
     * nothing here ever drew it -- so treating "known" as "correct" left that screen empty for
     * the rest of the run. It is asymmetric because the joiner's own body *is* drawn properly
     * by the pass below, which is why one side saw the other and not the reverse.
     *
     * So: no record of *this* code having drawn it is not evidence the screen is right. Draw it
     * and start tracking. A body this pass has drawn is recorded, so a healthy scope still
     * costs two lookups and sends nothing.
     */
    private static viewerNeedsPlayerBodyRedrawn(viewer: Client, subject: Client): boolean {
        if (!viewer.knownEntityIds.has(subject.clientEntID)) {
            return true;
        }

        const drawnRoomId = viewer.drawnPlayerRoomIds?.get(subject.clientEntID);
        if (drawnRoomId === undefined) {
            return true;
        }

        return drawnRoomId !== Math.round(Number(subject.currentRoomId ?? -1));
    }

    // Three sweep ticks. Long enough that a real fall lands first, short enough that nobody
    // stands next to an invisible party member wondering what is wrong.
    private static readonly PLAYER_BODY_PLACEMENT_REFUSAL_LIMIT = 3;
    private static readonly playerBodyPlacementRefusals = new Map<string, number>();

    private static sendPlayerBodyToViewer(viewer: Client, subject: Client, force: boolean = true): boolean {
        if (
            viewer === subject ||
            !subject.character ||
            subject.clientEntID <= 0 ||
            !viewer.playerSpawned ||
            !subject.playerSpawned ||
            !areClientsInSameLevelScope(viewer, subject)
        ) {
            return false;
        }
        // A re-seed is a spawn: the client destroys its copy and rebuilds it, which resets the
        // animation. The reconcile sweep therefore only draws a body that is missing from this
        // screen, or one this screen is showing in a room the player is no longer in -- the
        // only two states a viewer can be wrong in. The seed and retry passes force, because
        // there the point is to (re)place it.
        if (!force && !EntityHandler.viewerNeedsPlayerBodyRedrawn(viewer, subject)) {
            return false;
        }
        // The same character logged in twice is one player, not two bodies.
        if (
            viewer.userId &&
            subject.userId &&
            viewer.userId === subject.userId &&
            viewer.character?.name === subject.character?.name
        ) {
            return false;
        }

        // Never hand a client a body under the id it calls its own by. The spawn reader would
        // look the id up, find that client's own body, destroy it and rebuild it as this
        // subject; the client's next self update puts its own body back and destroys the copy.
        // Neither player's body survives on the other's screen, both still see themselves, and
        // the party frame reads 0ft because the entity filed under the other name is their own
        // body. The id allocator now avoids this, so reaching here means it was defeated.
        if (subject.clientEntID === EntityHandler.getLocalSelfEntityId(viewer)) {
            console.warn(
                `[PlayerVisibility] refusing to draw ${subject.character?.name ?? '?'} for ` +
                `${viewer.character?.name ?? '?'}: entity id ${subject.clientEntID} is the id that ` +
                'client uses for its own body -- sending it would destroy their own character'
            );
            return false;
        }

        const props = subject.entities.get(subject.clientEntID);
        if (!props) {
            return false;
        }

        // Null means "nowhere safe to put this body yet" -- airborne with no confirmed floor
        // sample. Seeding it anyway is the player appearing in mid-air and falling into the
        // room, which is what this refuses to do.
        //
        // But the refusal must not be permanent, and that is what kept this one-way. The flags
        // it reads live on the *stored* body and are only rewritten by a movement packet, so a
        // player who lands and then stands still keeps whatever the last packet said -- often
        // `dropping` from the landing itself. Nobody sends anything while standing still, so
        // the body is refused on every pass, forever, and that screen stays empty while the
        // reverse direction works perfectly. After a few seconds of refusing, the live position
        // is the honest answer: the player is demonstrably not moving, so it is where they are.
        const pairKey = `${viewer.token}:${subject.clientEntID}`;
        let placed = EntityHandler.withGroundedBodyPosition(props, subject.currentLevel);
        if (!placed) {
            const refusals = (EntityHandler.playerBodyPlacementRefusals.get(pairKey) ?? 0) + 1;
            if (refusals < EntityHandler.PLAYER_BODY_PLACEMENT_REFUSAL_LIMIT) {
                EntityHandler.playerBodyPlacementRefusals.set(pairKey, refusals);
                return false;
            }

            console.warn(
                `[PlayerVisibility] drawing ${subject.character?.name ?? '?'} for ` +
                `${viewer.character?.name ?? '?'} at their live position after ${refusals} refusals ` +
                '(no confirmed floor sample and the body reads as airborne while standing still)'
            );
            placed = props;
        }
        EntityHandler.playerBodyPlacementRefusals.delete(pairKey);

        // A spawn places a body; it does not decide whether that body is alive.
        //
        // `placed` is the subject's stored entity and it carries whatever death flags that record
        // happens to hold -- and those flags are sticky: nothing rewrites them until a movement
        // packet arrives, so a player who died once, or whose record was written while the server
        // briefly believed they were dead, is drawn face-down on every screen that draws them
        // afterwards. Live: both members lying in the death pose at 0% dungeon progress, neither
        // having taken a single point of damage, both at full health on their own screen.
        //
        // Death is announced separately and authoritatively by `broadcastPlayerState`, which
        // refuses to contradict the player's own reported health. So a spawn always places a
        // living body and lets that path say otherwise.
        const spawnBody = (placed && typeof placed === 'object')
            ? { ...placed, dead: false, entState: EntityState.ACTIVE }
            : placed;

        EntityHandler.sendEntity(
            viewer,
            Entity.fromCharacter(subject.clientEntID, subject.character, spawnBody)
        );
        EntityHandler.sendOtherPlayerMountToJoiner(viewer, subject);
        // Straight after the body, so the cast can never arrive before the entity it names.
        EntityHandler.playArrivalEffectForViewer(viewer, subject);
        // Record which room this screen now shows the body in. A 0x0F spawn is the only packet
        // that can move it across a room boundary, so this is what later tells us the copy is
        // stale and has to be drawn again.
        viewer.drawnPlayerRoomIds?.set(subject.clientEntID, Math.round(Number(subject.currentRoomId ?? -1)));
        return true;
    }

    /**
     * Make everybody in this scope visible to everybody else, both directions.
     *
     * Player visibility used to be two one-shot half-exchanges -- the joiner pulled the
     * others in on spawn, the others were pushed the joiner -- and either half failing left
     * the pair permanently one-way, which is exactly what a door produced: the player who
     * walked through saw the party and the party could not see them (or the reverse), for
     * the rest of the run, with nothing to retry it.
     *
     * A door is also a race. The two connections and the two spawns interleave in any order,
     * and a body the subject's own client has not reported yet cannot be sent at all. So this
     * runs on spawn and again on a short retry, and it is symmetric: whichever half was not
     * possible the first time is simply done on the next pass.
     *
     * `force` belongs to the seed pass only. A redraw is a full re-spawn on the viewer's client
     * -- it destroys its copy and rebuilds it -- so a *forced* retry over a body that is already
     * correct is a visible re-entry: the arriving player drops into the room again, and anything
     * playing on that body (the arrival effect) is cut off mid-animation. The retries now ask
     * `viewerNeedsPlayerBodyRedrawn` first, which is not weaker than forcing: a seed that never
     * landed leaves no `drawnPlayerRoomIds` entry, and neither does the relay path that marks an
     * id known without drawing it ([[known-entity-id-is-not-proof-a-body-was-drawn]]), so both
     * still redraw.
     */
    private static syncPlayerVisibilityInScope(client: Client, force: boolean = true): void {
        const levelScope = getClientLevelScope(client);
        if (!client.playerSpawned || !levelScope) {
            return;
        }

        for (const other of EntityHandler.getSpawnedSessionsInScope(levelScope)) {
            if (other === client) {
                continue;
            }

            EntityHandler.sendPlayerBodyToViewer(client, other, force);
            EntityHandler.sendPlayerBodyToViewer(other, client, force);
        }
    }

    /**
     * Put back a player body the viewer's client says it has dropped.
     *
     * A client emits `0x0D` for everything it lets go of while unloading a level, other
     * players included, and honouring that is what left two people standing on the same tile
     * unable to see each other ([[client-destroy-deletes-peer-player-body]]). Ignoring it is
     * not enough either: the client really has thrown its copy away, so if the server just
     * drops the packet the body stays gone and `knownEntityIds` still claims it is there,
     * which suppresses every later reconcile. Forget it, then draw it again.
     */
    /**
     * Mark this player's body stale on every other screen in the scope.
     *
     * Room ids are not a reliable trigger. They only move when the client sends one of the room
     * packets, and a dungeon can run its whole length reporting room 0 -- the live
     * `[Visibility]` log showed exactly that, `room=0` for both players, so a redraw keyed on
     * the room id never fired for any door.
     *
     * What is always true of a door, a room transition or any other teleport is that the jump
     * produces **no movement deltas anyone can relay**. So the trigger is the jump itself,
     * wherever the server sees one, and it covers every transition in every dungeon without
     * depending on the client's room bookkeeping. Forgetting the draw record is enough: the
     * sweep redraws within a tick, and only for the screens that are actually holding a stale
     * copy.
     */
    static markPlayerBodyNeedsRedraw(subject: Client): void {
        const entityId = Math.max(0, Math.round(Number(subject.clientEntID) || 0));
        const levelScope = getClientLevelScope(subject);
        if (entityId <= 0 || !levelScope) {
            return;
        }

        for (const viewer of EntityHandler.getSpawnedSessionsInScope(levelScope)) {
            if (viewer !== subject) {
                viewer.drawnPlayerRoomIds?.delete(entityId);
            }
        }
    }

    /**
     * Mark every *other* player's body stale on this one client's screen.
     *
     * The mirror image of `markPlayerBodyNeedsRedraw`, and the half that was missing. Walking
     * through a door tears the old room down on the mover's own client, and it lets go of
     * everything that room held -- the other players included. Nothing put them back: the
     * server still had a draw record for each of them, so the sweep considered that screen
     * correct and stayed silent for the rest of the run. Marking the records stale is enough;
     * the sweep and the transition resync redraw within a second, and only for this viewer.
     */
    static markPeerBodiesNeedRedrawForViewer(viewer: Client): void {
        const levelScope = getClientLevelScope(viewer);
        if (!levelScope || !viewer.drawnPlayerRoomIds) {
            return;
        }

        for (const subject of EntityHandler.getSpawnedSessionsInScope(levelScope)) {
            if (subject !== viewer) {
                viewer.drawnPlayerRoomIds.delete(subject.clientEntID);
            }
        }
    }

    /**
     * Redraw the bodies on both sides of a door, twice, after the room has had time to load.
     *
     * One pass is not enough and never was: a client drops the spawns for a room it is not
     * standing in yet, so a body sent while it is still swapping rooms is silently discarded --
     * and the server, having recorded the draw, never sends it again. The second pass is what
     * covers a slow room load; both are cheap, and each only sends what the screen is actually
     * missing, so an already-correct pair costs a map lookup.
     */
    private static readonly ROOM_TRANSITION_REDRAW_DELAYS_MS = [700, 2200];

    static scheduleRoomTransitionRedraw(client: Client): void {
        const token = client.token;
        for (const delayMs of EntityHandler.ROOM_TRANSITION_REDRAW_DELAYS_MS) {
            setTimeout(() => {
                if (!client.playerSpawned || client.token !== token) {
                    return;
                }

                EntityHandler.markPlayerBodyNeedsRedraw(client);
                EntityHandler.markPeerBodiesNeedRedrawForViewer(client);
                EntityHandler.reconcilePlayerVisibilityInScope(client);
            }, delayMs).unref?.();
        }
    }

    static resendPlayerBodyToViewer(viewer: Client, subjectEntityId: number): boolean {
        const entityId = Math.max(0, Math.round(Number(subjectEntityId) || 0));
        if (entityId <= 0 || !viewer.playerSpawned) {
            return false;
        }

        const levelScope = getClientLevelScope(viewer);
        for (const subject of EntityHandler.getSpawnedSessionsInScope(levelScope)) {
            if (subject === viewer || subject.clientEntID !== entityId) {
                continue;
            }

            viewer.knownEntityIds.delete(entityId);
            viewer.drawnPlayerRoomIds?.delete(entityId);
            return EntityHandler.sendPlayerBodyToViewer(viewer, subject);
        }

        return false;
    }

    /**
     * Re-draw any player body a viewer in this scope is missing.
     *
     * Visibility cannot be a one-shot event. Whatever the reason a body goes missing on one
     * screen -- a teardown, a dropped packet, a spawn that arrived while the level was still
     * loading -- nothing used to put it back, so it stayed missing for the rest of the run.
     * This is the standing invariant: it only sends what the viewer is not already holding,
     * so a scope where everyone can see everyone costs a couple of set lookups.
     */
    static reconcilePlayerVisibilityInScope(client: Client): void {
        const levelScope = getClientLevelScope(client);
        if (!client.playerSpawned || !levelScope) {
            return;
        }

        for (const other of EntityHandler.getSpawnedSessionsInScope(levelScope)) {
            if (other === client) {
                continue;
            }

            EntityHandler.sendPlayerBodyToViewer(client, other, false);
            EntityHandler.sendPlayerBodyToViewer(other, client, false);
        }
    }

    /**
     * Keep every screen correct on a timer, not on a packet.
     *
     * Every earlier attempt at this hung off some packet path -- the spawn, two timed retries,
     * a hook on the mover's own movement update. A door is a full level reload onto a new TCP
     * connection, and each of those paths has its own early returns and its own ordering
     * against that reload, so any one of them can simply not run for the pair that needs it.
     * The result was a fix that worked in the test and not in the room.
     *
     * This owes nothing to any packet arriving. It walks the live sessions once a second and
     * draws only what a screen is actually wrong about -- a body missing, or a body sitting in
     * a room the player has left -- so it is silent whenever everything is already correct,
     * and it keeps retrying a body that had to be refused for being mid-air until it lands.
     */
    private static readonly PLAYER_VISIBILITY_SWEEP_INTERVAL_MS = 1000;
    private static playerVisibilitySweep: ReturnType<typeof setInterval> | null = null;

    private static lastSplitScopeReport = '';

    /**
     * Say it out loud when two party members are standing in the same level on different
     * instances.
     *
     * Nothing above this can help them: visibility, health relay, progress and loot are all
     * scoped, so a split instance is two private runs that happen to look identical. It is also
     * the one failure that looks exactly like a visibility bug from the outside -- same room,
     * same spot, cannot see each other -- so when it happens the log should name it rather than
     * leaving the next person to re-derive it. Logged only when the picture changes, so a
     * healthy party is silent.
     */
    private static lastVisibilityReport = '';
    private static lastHostileSnapshotReport = '';

    /**
     * Does every party member hold the same set of enemies the run actually has?
     *
     * In The East Wing each client also spawns its own copy of every hostile, so the shared run
     * only works while each of those copies is *bound* to a canonical
     * ([[east-wing-is-both-client-spawn-and-server-authority]]). An unbound copy is a private
     * enemy: its own health, its own death, its own contribution to the clear count -- which is
     * exactly "the player who joined later does not get the same snapshot".
     *
     * Binding is the one thing none of the delivery fixes can compensate for, and it is
     * invisible from the outside, so it gets counted here: per member, how many of the scope's
     * canonical hostiles they can resolve, and which ones they cannot. Logged only on change.
     */
    private static reportHostileSnapshotAgreement(levelScope: string): void {
        const levelName = getScopeLevelName(levelScope);
        if (!EntityHandler.usesServerAuthorityHostiles(levelName)) {
            return;
        }

        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (!levelMap) {
            return;
        }

        const canonicalIds: number[] = [];
        for (const entity of levelMap.values()) {
            if (
                EntityHandler.isServerAuthorityHostileEntity(levelName, entity) &&
                !EntityHandler.isEntityDead(entity)
            ) {
                canonicalIds.push(Math.max(0, Math.round(Number(entity.id ?? 0))));
            }
        }
        if (canonicalIds.length === 0) {
            return;
        }

        const parts: string[] = [];
        for (const viewer of EntityHandler.getSpawnedSessionsInScope(levelScope)) {
            const missing = canonicalIds.filter((id) => !EntityHandler.canClientResolveCanonicalEntity(viewer, id));
            parts.push(
                `${String(viewer.character?.name ?? '?')}:${canonicalIds.length - missing.length}/${canonicalIds.length}` +
                (missing.length ? ` missing=[${missing.join(',')}]` : '')
            );
        }

        // Who is in a party but standing here alone? That is the split, and it is the reason
        // this line can otherwise look empty when two people believe they are together.
        const partied = EntityHandler.getSpawnedSessionsInScope(levelScope)
            .filter((session) => getPartyIdForClient(session) > 0);
        const aloneInParty = partied.length === 1
            ? ` PARTY-MEMBER-ALONE-IN-THIS-SCOPE=${String(partied[0].character?.name ?? '?')}`
            : '';

        const report =
            `${levelScope} live=${canonicalIds.length} ${parts.sort().join(' ')}${aloneInParty}`;
        if (report === EntityHandler.lastHostileSnapshotReport) {
            return;
        }
        EntityHandler.lastHostileSnapshotReport = report;
        if (aloneInParty || parts.some((part) => part.includes('missing='))) {
            console.warn(`[HostileSnapshot] members do not hold the same enemies: ${report}`);
        } else {
            console.log(`[HostileSnapshot] ${report}`);
        }
    }

    /**
     * Say, every second, what the server believes about each pair who should see each other.
     *
     * This exists because the same symptom -- "we are standing together and cannot see each
     * other" -- has had six different causes in this system, and none of them can be told apart
     * from the outside. One line per ordered pair, logged only when the picture changes, naming
     * the exact blocking condition. If it says `drawn`, the server has done its part and the
     * next place to look is the client; anything else names the server-side reason outright.
     */
    private static reportPlayerVisibilityState(): void {
        const lines: string[] = [];
        const spawned = Array.from(GlobalState.sessionsByToken.values()).filter(
            (session) => session.playerSpawned && session.character
        );

        for (const viewer of spawned) {
            for (const subject of spawned) {
                if (viewer === subject) {
                    continue;
                }
                if (getPartyIdForClient(viewer) <= 0 || !areClientsInSameParty(viewer, subject)) {
                    continue;
                }

                const names = `${subject.character?.name ?? '?'}->${viewer.character?.name ?? '?'}`;
                let state: string;
                if (!areClientsInSameLevelScope(viewer, subject)) {
                    state = `SPLIT-SCOPE viewer=${getClientLevelScope(viewer)} subject=${getClientLevelScope(subject)}`;
                } else if (subject.clientEntID <= 0) {
                    state = 'subject has no entity id yet';
                } else if (subject.clientEntID === EntityHandler.getLocalSelfEntityId(viewer)) {
                    state = `ID-COLLISION id=${subject.clientEntID} is the viewer's own body id`;
                } else if (!subject.entities.get(subject.clientEntID)) {
                    state = `no stored body for id=${subject.clientEntID}`;
                } else if (!EntityHandler.withGroundedBodyPosition(
                    subject.entities.get(subject.clientEntID),
                    subject.currentLevel
                )) {
                    state = 'placement refused (airborne, no confirmed floor sample)';
                } else if (!viewer.drawnPlayerRoomIds?.has(subject.clientEntID)) {
                    state = `not drawn yet (known=${viewer.knownEntityIds.has(subject.clientEntID)})`;
                } else {
                    const drawnRoom = viewer.drawnPlayerRoomIds.get(subject.clientEntID);
                    state = drawnRoom === Math.round(Number(subject.currentRoomId ?? -1))
                        ? `drawn id=${subject.clientEntID} room=${drawnRoom}`
                        : `drawn in the WRONG room drawn=${drawnRoom} actual=${subject.currentRoomId}`;
                }

                lines.push(`${names}: ${state}`);
            }
        }

        const report = lines.sort().join(' ;; ');
        if (report === EntityHandler.lastVisibilityReport) {
            return;
        }
        EntityHandler.lastVisibilityReport = report;
        if (report) {
            console.log(`[Visibility] ${report}`);
        }
    }

    private static reportPartyMembersInSplitScopes(): void {
        const scopesByParty = new Map<number, Map<string, string[]>>();
        for (const session of GlobalState.sessionsByToken.values()) {
            const partyId = getPartyIdForClient(session);
            if (!session.playerSpawned || partyId <= 0) {
                continue;
            }
            const levelScope = getClientLevelScope(session);
            if (!levelScope) {
                continue;
            }
            let scopes = scopesByParty.get(partyId);
            if (!scopes) {
                scopes = new Map<string, string[]>();
                scopesByParty.set(partyId, scopes);
            }
            const names = scopes.get(levelScope) ?? [];
            names.push(String(session.character?.name ?? '?'));
            scopes.set(levelScope, names);
        }

        const lines: string[] = [];
        for (const [partyId, scopes] of scopesByParty) {
            if (scopes.size < 2) {
                continue;
            }
            const parts = Array.from(scopes.entries())
                .map(([scope, names]) => `${names.sort().join('+')}@${scope}`)
                .sort();
            lines.push(`party ${partyId}: ${parts.join(' | ')}`);
        }

        const report = lines.sort().join(' ;; ');
        if (report === EntityHandler.lastSplitScopeReport) {
            return;
        }
        EntityHandler.lastSplitScopeReport = report;
        if (report) {
            console.warn(
                `[PartyScope] party members are in DIFFERENT level scopes -- they cannot see ` +
                `each other, share enemies or share progress until this converges: ${report}`
            );
        }
    }

    /**
     * Re-send the canonical hostiles of a server-drawn level to everyone in the scope.
     *
     * `sendInitialLevelEntities` is the only place these are sent and it fires once per level
     * entry, so any of the 34 a client misses in that burst is gone for the rest of the run --
     * reported live as "some enemies are missing", and as one player seeing an enemy the other
     * does not.
     *
     * Retries on a counter, deliberately NOT on `viewer.entities`. The send path fills that map
     * itself, so the server always believes it drew the entity: gating on it means the one case
     * this exists for -- a client that did not act on the spawn -- is the exact case it would
     * never retry. That is the trap `reconcileDeadHostilesForScope` already had to learn: if
     * what makes it fire a second time is state the send itself sets, it is not a reconcile.
     *
     * Re-sending is safe. The 0x0F reader is idempotent by design: it tears down and rebuilds
     * any entity already holding the id. A redundant spawn costs one redraw; a missing one
     * costs the enemy for the whole run. The counter stops it ever becoming a stream.
     */
    static reconcileDrawnHostilesForScope(levelScope: string, sessions: Client[]): void {
        const levelName = getScopeLevelName(levelScope);
        if (!EntityHandler.usesCanonicalVisibleServerAuthorityHostiles(levelName)) {
            return;
        }

        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (!levelMap) {
            return;
        }

        for (const [entityId, entityProps] of levelMap.entries()) {
            if (entityProps?.isPlayer) continue;
            if (entityProps?.clientSpawned) continue;
            if ((entityProps as any)?.serverOnlyObjective) continue;
            if (EntityHandler.isEntityDead(entityProps)) continue;
            // The boss stays client-spawned, so the server must never draw it.
            if (EntityHandler.isCanonicalRoomBossEntity(entityProps)) continue;
            if (!EntityHandler.isServerAuthorityHostileEntity(levelName, entityProps)) continue;

            for (const viewer of sessions) {
                // Keyed by the viewer's CURRENT ROOM, not just the viewer.
                //
                // A client accepts the spawns for the room it is standing in and drops the
                // rest, so one budget per run is spent in the first few seconds while the
                // player is still in room 1 -- and rooms 2..4 are then never sent again. That
                // is "the enemies are missing" for both players at once, in exactly the rooms
                // they had not reached yet. A room change earns a fresh budget, so walking
                // into a room draws its enemies.
                const retryKey = `${viewer.token}:${Math.round(Number(viewer.currentRoomId ?? -1))}:${entityId}`;
                const attempts = EntityHandler.drawnHostileRetries.get(retryKey) ?? 0;
                if (attempts >= EntityHandler.DRAWN_HOSTILE_RETRY_LIMIT) {
                    continue;
                }
                EntityHandler.drawnHostileRetries.set(retryKey, attempts + 1);

                viewer.entities.set(entityId, { ...entityProps });
                noteDungeonRunEntitySeen(viewer, entityId, entityProps);
                EntityHandler.sendEntity(viewer, entityProps);
            }
        }
    }

    /** Lets a fresh run redraw from scratch instead of inheriting a spent retry budget. */
    static forgetDrawnHostileRetries(levelScope: string): void {
        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (!levelMap) {
            return;
        }
        for (const key of Array.from(EntityHandler.drawnHostileRetries.keys())) {
            const entityId = Number(key.slice(key.lastIndexOf(':') + 1));
            if (levelMap.has(entityId)) {
                EntityHandler.drawnHostileRetries.delete(key);
            }
        }
    }

    static startPlayerVisibilitySweep(): void {
        if (EntityHandler.playerVisibilitySweep) {
            return;
        }

        EntityHandler.playerVisibilitySweep = setInterval(() => {
            EntityHandler.reportPartyMembersInSplitScopes();
            EntityHandler.reportPlayerVisibilityState();

            const seenScopes = new Set<string>();
            for (const session of GlobalState.sessionsByToken.values()) {
                if (!session.playerSpawned) {
                    continue;
                }
                const levelScope = getClientLevelScope(session);
                if (!levelScope || seenScopes.has(levelScope)) {
                    continue;
                }
                seenScopes.add(levelScope);

                const sessions = EntityHandler.getSpawnedSessionsInScope(levelScope);
                // Reported before the two-member gate, deliberately. A scope holding a single
                // session is not "nothing to check": if that session is in a party, it IS the
                // party split -- the one failure none of the delivery fixes can touch. Gating
                // this behind the gate hid exactly the case it exists to show.
                EntityHandler.reportHostileSnapshotAgreement(levelScope);

                // Drawing them once is not enough; see reconcileDrawnHostilesForScope. Runs
                // before the two-member gate: a solo run drops spawns exactly the same way.
                EntityHandler.reconcileDrawnHostilesForScope(levelScope, sessions);
                if (sessions.length < 2) {
                    continue;
                }

                // Drawing an enemy on both screens is not enough; they also have to agree on
                // where it is standing.
                EntityHandler.reconcileHostilePositionsForScope(levelScope, sessions);

                // And the party frames, which drift the same way for the same reason.
                EntityHandler.reconcilePartyFrameHealthForScope(levelScope, sessions);

                // A dead enemy is dead for the whole party. Reconciled here rather than
                // announced once, so a member who missed the death packet does not spend the
                // rest of the run fighting a corpse nobody else can see.
                {
                    const { CombatHandler } = require('./CombatHandler') as typeof import('./CombatHandler');
                    CombatHandler.reconcileDeadHostilesForScope(levelScope);
                }
                for (const viewer of sessions) {
                    for (const subject of sessions) {
                        if (viewer !== subject) {
                            EntityHandler.sendPlayerBodyToViewer(viewer, subject, false);
                        }
                    }
                }
            }
        }, EntityHandler.PLAYER_VISIBILITY_SWEEP_INTERVAL_MS);
        EntityHandler.playerVisibilitySweep.unref?.();
    }

    /**
     * How far a viewer's copy of an enemy may sit from the canonical before it is pulled back.
     *
     * Small enough that the two screens agree about what an enemy is standing next to, large
     * enough that ordinary relay jitter is not constantly corrected -- a correction is a visible
     * slide, so nudging every frame would look worse than the drift.
     */
    private static readonly HOSTILE_POSITION_DRIFT_LIMIT = 90;

    /**
     * Pull every viewer's copy of every enemy back onto the one the owner is driving.
     *
     * Movement is relayed as DELTAS, and every client also runs the enemy AI for itself. A delta
     * applied from a different starting point preserves the difference, so the two views separate
     * a little on every packet and never come back -- the same enemy ends up beside one player
     * and off the far edge of the other's screen, and neither player can tell what it is
     * attacking. Relaying more deltas cannot fix that; only an absolute correction can.
     *
     * The client has no reader for an absolute position that is not a spawn, and a spawn rebuilds
     * the body (it would restart the animation and flicker). So the correction is expressed the
     * only way the client will accept mid-room: a 0x07 delta of exactly the gap, which lands the
     * copy on the canonical.
     */
    private static reconcileHostilePositionsForScope(levelScope: string, sessions: Client[]): void {
        const levelName = getScopeLevelName(levelScope);
        if (!EntityHandler.usesServerAuthorityHostiles(levelName) || sessions.length < 2) {
            return;
        }

        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (!levelMap) {
            return;
        }

        const { LevelHandler } = require('./LevelHandler') as typeof import('./LevelHandler');
        const { CombatHandler } = require('./CombatHandler') as typeof import('./CombatHandler');
        for (const canonical of levelMap.values()) {
            if (!EntityHandler.isServerAuthorityHostileEntity(levelName, canonical) || EntityHandler.isEntityDead(canonical)) {
                continue;
            }
            const canonicalId = Math.max(0, Math.round(Number(canonical.id ?? 0)));
            const canonicalX = Number(canonical.x ?? NaN);
            const canonicalY = Number(canonical.y ?? NaN);
            if (canonicalId <= 0 || !Number.isFinite(canonicalX) || !Number.isFinite(canonicalY)) {
                continue;
            }

            const ownerToken = Math.max(0, Math.round(Number(canonical.proxyOwnerToken ?? 0)));
            for (const viewer of sessions) {
                // The owner IS the canonical's position; correcting them would fight their own
                // simulation.
                if (viewer.token === ownerToken || getClientLevelScope(viewer) !== levelScope) {
                    continue;
                }

                const localId = CombatHandler.resolvePartySharedHostileLocalIdForSharedState(
                    viewer,
                    levelScope,
                    canonicalId,
                    canonical
                );
                if (localId <= 0) {
                    continue;
                }
                const localCopy = viewer.entities.get(localId);
                const localX = Number(localCopy?.x ?? NaN);
                const localY = Number(localCopy?.y ?? NaN);
                if (!localCopy || !Number.isFinite(localX) || !Number.isFinite(localY)) {
                    continue;
                }

                const deltaX = Math.round(canonicalX - localX);
                const deltaY = Math.round(canonicalY - localY);
                if (Math.abs(deltaX) < EntityHandler.HOSTILE_POSITION_DRIFT_LIMIT &&
                    Math.abs(deltaY) < EntityHandler.HOSTILE_POSITION_DRIFT_LIMIT) {
                    continue;
                }

                viewer.send(
                    0x07,
                    LevelHandler.buildEntityIncrementalUpdatePayload(
                        localId,
                        deltaX,
                        deltaY,
                        0,
                        Math.round(Number(canonical.entState ?? EntityState.ACTIVE)),
                        {
                            bLeft: Boolean(canonical.facingLeft),
                            bRunning: false,
                            bJumping: false,
                            bDropping: false,
                            bBackpedal: false
                        },
                        false,
                        0
                    )
                );
                localCopy.x = Math.round(canonicalX);
                localCopy.y = Math.round(canonicalY);
            }
        }
    }

    /**
     * Keep every party frame showing each member's real health.
     *
     * The frame is drawn from the HP deltas a client receives, so its bar is the sum of whatever
     * happened to arrive. Deltas go out room-scoped, a death is announced as a state packet with
     * no health in it, and anything sent before a body was drawn lands nowhere -- so the bar
     * drifts and nothing pulled it back. Live: a member dead at 0/68109 reading as a sliver of
     * health on the other frame, and a member at 18182/91040 reading as nearly full.
     *
     * There is no absolute-health packet, so the correction is the difference, and what the
     * viewer is currently showing has to be tracked to compute it. Same shape as the hostile
     * position reconcile: measure, send the gap, record it as landed.
     */
    /**
     * OFF, and it must stay off until the server's own player-health figures are trustworthy.
     *
     * This pass writes the server's idea of a player's health onto everybody else's party frame.
     * That is only an improvement if the server's figure is right, and it is not: a live capture
     * had a level 50 at 91040/91040 on their own screen while the server held `1186/21724` for
     * them -- 21724 is the level 25 row of the player health table, for a level 50 character.
     * Reconciling against that number does not fix a stale frame, it drives a healthy player's
     * bar down to nothing and then shows them as dead, once a second, from the moment they walk
     * in. That is worse than the drift it was meant to correct.
     *
     * The measurement stays (see the `[PartyFrameHp]` line below): it is what exposed the bad
     * figures. Turn this back on once `authoritativeMaxHp`/`authoritativeCurrentHp` agree with
     * what the client shows.
     */
    private static readonly PARTY_FRAME_HEALTH_RECONCILE_ENABLED = false;

    private static reconcilePartyFrameHealthForScope(levelScope: string, sessions: Client[]): void {
        if (sessions.length < 2) {
            return;
        }

        const { CombatHandler } = require('./CombatHandler') as typeof import('./CombatHandler');
        for (const subject of sessions) {
            const subjectId = Math.max(0, Math.round(Number(subject.clientEntID ?? 0)));
            const subjectBody = subject.entities.get(subjectId);
            const subjectPool = Math.max(
                Math.round(Number(subject.authoritativeMaxHp ?? 0)),
                Math.round(Number(subjectBody?.maxHp ?? 0))
            );
            // An unknown health is treated as FULL, never as empty.
            //
            // A party frame starts with no health data, so an empty bar is what a viewer sees
            // until something fills it -- and an empty bar reads as a dead player. On entry
            // `authoritativeCurrentHp` is still zero (the client has not reported yet), so
            // skipping this pass left both members showing as dead in the HUD the moment they
            // walked in. Assuming full is the safe direction: a player who really is dead is
            // announced through `notePlayerDeathState`, which empties the bar explicitly, and the
            // next pass corrects any overestimate as soon as the client reports.
            const reportedHp = Math.round(Number(subject.authoritativeCurrentHp ?? NaN));
            const realHp = Number.isFinite(reportedHp) && reportedHp > 0
                ? reportedHp
                : subjectPool;
            // Zero is not "dead" here, it is "this client has not reported its health yet".
            //
            // `authoritativeCurrentHp` starts at zero and only becomes real once the client sends
            // its first health packet, which is AFTER it is already visible to the party. Reading
            // that as a dead player made this drain the bar of a member who had just walked in at
            // full health and had never been touched -- both members lying in the death pose at
            // 0% dungeon progress. Death has its own path (`notePlayerDeathState`) and does not
            // need this one; a reconcile only ever corrects a living figure.
            if (subjectId <= 0 || !Number.isFinite(realHp) || realHp <= 0) {
                continue;
            }

            for (const viewer of sessions) {
                if (viewer === subject || !viewer.playerSpawned || getClientLevelScope(viewer) !== levelScope) {
                    continue;
                }

                const shown = Math.round(Number(viewer.partyFrameHpByEntityId.get(subjectId) ?? NaN));
                // "Nothing recorded yet" used to mean "assume the frame is already right", and it
                // is not: a party frame starts with no health data at all, so the bar is drawn
                // EMPTY until something sends some. Adopting the real figure without sending it
                // left both members showing a blank bar from the moment they walked in, never
                // having been hit. The first pass has to build the bar, not just note it.
                if (Number.isFinite(shown) && shown === realHp) {
                    continue;
                }

                // Rebuilt absolutely, not nudged by the difference.
                //
                // The tracked figure is only ever an estimate -- other paths send HP deltas of
                // their own and cannot all be intercepted -- and a difference computed from a
                // wrong estimate leaves the bar wrong in a NEW way. Emptying the bar outright and
                // refilling it to the real figure lands on the right value no matter how far the
                // estimate had drifted. The client's own health code clamps at both ends, so the
                // oversized drain costs nothing.
                const pool = Math.max(1, subjectPool, realHp);
                if (!EntityHandler.PARTY_FRAME_HEALTH_RECONCILE_ENABLED) {
                    // Measure and report only. See the note on the flag.
                    if (!Number.isFinite(shown)) {
                        console.log(
                            `[PartyFrameHp] ${getScopeLevelName(levelScope)} ` +
                            `subject=${String(subject.character?.name ?? '?')} id=${subjectId} ` +
                            `-> viewer=${String(viewer.character?.name ?? '?')} ` +
                            `serverThinks=${realHp}/${pool} ` +
                            `reported=${Number.isFinite(reportedHp) ? reportedHp : 'none'} ` +
                            // The one field that decides which row of the player health table is
                            // read. A level 50 resolving to 21724 -- the level 25 row -- is either
                            // a wrong level or a wrong lookup, and only this separates them.
                            `level=${Math.round(Number(subject.character?.level ?? -1))} ` +
                            `authMax=${Math.round(Number(subject.authoritativeMaxHp ?? -1))} ` +
                            `bodyMax=${Math.round(Number(subjectBody?.maxHp ?? -1))}`
                        );
                        viewer.partyFrameHpByEntityId.set(subjectId, realHp);
                    }
                    continue;
                }
                // The only record that this pass ran. Without it a blank party frame and a frame
                // this code never reached look identical from the log, which is exactly the
                // ambiguity the last few rounds were stuck on.
                if (!Number.isFinite(shown)) {
                    console.log(
                        `[PartyFrameHp] ${getScopeLevelName(levelScope)} ` +
                        `subject=${String(subject.character?.name ?? '?')} id=${subjectId} ` +
                        `-> viewer=${String(viewer.character?.name ?? '?')} ` +
                        `built=${realHp}/${pool} ` +
                        `reported=${Number.isFinite(reportedHp) ? reportedHp : 'none'}`
                    );
                }
                // Only ever reached with a living figure -- the guard above skips a subject whose
                // client has not reported health yet, so the drain can never be the whole story.
                CombatHandler.sendPlayerHealthCorrection(viewer, subjectId, -pool);
                CombatHandler.sendPlayerHealthCorrection(viewer, subjectId, realHp);
                viewer.partyFrameHpByEntityId.set(subjectId, realHp);
            }
        }
    }

    static schedulePlayerVisibilityResync(client: Client): void {
        const token = client.token;
        for (const delayMs of EntityHandler.PLAYER_VISIBILITY_RESYNC_DELAYS_MS) {
            setTimeout(() => {
                // Deliberately not pinned to the scope captured at schedule time. The scope
                // guard can move a session onto the party's instance at any point after it
                // spawns (combat relay, level entry), and a retry cancelled because the
                // scope "changed" is a retry cancelled exactly when it was most needed --
                // that is the run where the leader never receives the member who walked
                // through the door. The token check is enough to drop a stale session.
                if (!client.playerSpawned || client.token !== token) {
                    return;
                }

                // Not forced: this is a retry for the halves the seed could not do, not a
                // second seed. See the note on syncPlayerVisibilityInScope.
                EntityHandler.syncPlayerVisibilityInScope(client, false);
            }, delayMs).unref?.();
        }
    }

    private static sendExistingPlayersToJoiner(joiner: Client): void {
        EntityHandler.startPlayerVisibilitySweep();
        EntityHandler.syncPlayerVisibilityInScope(joiner);
        EntityHandler.schedulePlayerVisibilityResync(joiner);

        EntityHandler.replayStartedDungeonRoomEventsToJoiner(joiner);
        EntityHandler.scheduleExistingVisibleClientSpawnEntitiesToJoiner(joiner);
    }

    private static sendExistingVisibleClientSpawnEntitiesToJoiner(joiner: Client): void {
        if (!joiner.currentLevel) {
            return;
        }

        const levelMap = EntityHandler.getLevelMapForClient(joiner);
        if (!levelMap) {
            return;
        }

        for (const [entityId, entityProps] of levelMap.entries()) {
            if (entityId <= 0 || entityProps?.isPlayer || !entityProps?.clientSpawned) {
                continue;
            }
            if (EntityHandler.isEntityDead(entityProps)) {
                continue;
            }
            if (joiner.knownEntityIds.has(entityId)) {
                continue;
            }
            if (!EntityHandler.canClientSeeEntity(joiner, entityProps)) {
                continue;
            }
            if (EntityHandler.shouldDeferLiveSharedHostileSeedToJoiner(joiner, entityProps)) {
                continue;
            }

            const snapshot = EntityHandler.resolveCanonicalEntity(getClientLevelScope(joiner), entityId);
            if (!snapshot) {
                continue;
            }

            EntityHandler.sendEntity(joiner, snapshot);
        }
    }

    private static broadcastPlayerSpawn(client: Client, props: EntityProps): void {
        EntityHandler.refreshPlayerSnapshot(client);
    }

    static refreshPlayerSnapshot(client: Client, includeSelf: boolean = false): void {
        const playerEntity = EntityHandler.buildPlayerSnapshot(client);
        if (!playerEntity) {
            return;
        }

        // Self keeps the live position -- correcting a player's own body under them is a
        // rubber-band. Everyone else is being handed a spawn, so it goes on floor.
        const remoteEntity = EntityHandler.withGroundedBodyPosition(playerEntity, client.currentLevel);
        for (const other of EntityHandler.getSpawnedSessionsInScope(getClientLevelScope(client))) {
            if ((!includeSelf && other === client) || !other.playerSpawned || !areClientsInSameLevelScope(client, other)) {
                continue;
            }
            if (other === client) {
                EntityHandler.sendEntity(other, playerEntity);
                continue;
            }
            // Airborne with no confirmed floor sample: nothing safe to draw on a remote
            // screen, so this refresh skips them and the resync pass picks it up.
            if (remoteEntity) {
                EntityHandler.sendEntity(other, remoteEntity);
                // Record it exactly as the visibility pass would. This *is* a real placement,
                // so leaving no record would have the sweep redraw it a second later -- and a
                // redraw is a spawn, which rebuilds the body on the client.
                other.drawnPlayerRoomIds?.set(client.clientEntID, Math.round(Number(client.currentRoomId ?? -1)));
            }
        }
        if (!remoteEntity) {
            EntityHandler.schedulePlayerVisibilityResync(client);
        }
    }

    private static broadcastToLevel(sender: Client, data: Buffer, entity: EntityProps): void {
        const myLevel = sender.currentLevel;
        const myScope = getClientLevelScope(sender);
        if (!myLevel || !myScope || !sender.playerSpawned) return;

        for (const other of GlobalState.getSessionsInLevelScope(myScope)) {
            if (other === sender || !other.playerSpawned || getClientLevelScope(other) !== myScope) {
                continue;
            }
            if (!entity.isPlayer && EntityHandler.isEntityDead(entity)) {
                continue;
            }
            if (!entity.isPlayer && !EntityHandler.canClientSeeEntity(other, entity)) {
                continue;
            }
            if (
                !entity.isPlayer &&
                EntityHandler.shouldDeferLiveSharedHostileSeedToJoiner(other, entity) &&
                !other.knownEntityIds.has(entity.id)
            ) {
                continue;
            }
            if (!EntityHandler.ensureEntityKnown(other, myLevel, entity.id)) {
                continue;
            }

            const localEntityId = EntityHandler.resolveEntityLocalId(other, entity.id);
            const outboundData = !entity.isPlayer && localEntityId !== entity.id
                ? EntityHandler.buildEntityFullUpdatePayload({
                    ...entity,
                    id: localEntityId
                })
                : data;
            other.send(0x8, outboundData);
        }
    }
}
