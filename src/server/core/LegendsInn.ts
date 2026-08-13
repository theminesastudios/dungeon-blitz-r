import * as fs from 'fs';
import * as path from 'path';
import { Client } from './Client';
import { EntityProps, EntityState, EntityTeam } from './Entity';
import { GlobalState } from './GlobalState';
import { LevelConfig } from './LevelConfig';
import { getClientLevelScope, getScopeLevelName } from './LevelScope';

/**
 * Legends' Inn: the exit portal, and the door behind it.
 *
 * Legends' Inn is nine dungeons walked end to end, so eight of its nine stages
 * need a way onward that is *earned* rather than standing there from the moment
 * the room loads. The rule the whole file exists to enforce is one sentence: the
 * portal out of a stage does not exist until that stage's boss is dead.
 *
 * How it is built, and why it is built this way:
 *
 *   - **The portal is a server-spawned entity, not level art.** A level SWF has
 *     no way to reveal a child of a room part-way through a run - a room's
 *     children are constructed once, on load - but the server can push an entity
 *     into a level scope whenever it likes. So the stage SWF carries only the
 *     door, which is an editor marker and is drawn hidden, and the thing the
 *     player sees arrives on the boss's death packet.
 *   - **That also settles the name plate.** A door with artwork under it carries
 *     the floating plate naming where it leads, which is exactly what a dungeon
 *     that pretends to be one place must not show. An entity carries only its
 *     EntType's DisplayName, and LEGENDS_INN_PORTAL_ENT deliberately has none.
 *   - **And the animation comes free**: the EntType is drawn from
 *     `Animation_Nephit.swf/a__NephitPortal`, a looping rift, the same art the
 *     Astral Rifts in Deepgard use.
 *
 * The door itself is refused until the portal is open. Opening is per *level
 * scope*, not per player, because a stage is walked as a party: whoever lands the
 * killing blow opens it for everyone standing in that instance, and anyone who
 * joins or reconnects afterwards is handed the portal on arrival.
 *
 * Everything positional here - which door id the exit landed on, where it stands,
 * and what the stage's boss is now called - is read out of the file
 * build-legends-inn-stages.ts writes, so there is only ever one description of a
 * stage and it is the one the SWF was actually built from.
 */

export interface LegendsInnStageInfo {
    levelName: string;
    region: string;
    stage: number;
    exitDoorId: number;
    returnDoorId: number;
    monsterBonusLevels: number;
    portal: { x: number; y: number };
    /** Where the boss chest was placed. See `LegendsInnChest.isStageChest`. */
    chest: { x: number; y: number };
    bosses: string[];
    enemies: string[];
}

/**
 * Entity ids for the portals.
 *
 * Authored level entity ids in this project top out around 14.4M and the keep
 * statues took 26M, so this block collides with nothing. One id per stage, fixed,
 * so a re-send replaces the portal in place instead of stacking a second one.
 */
const PORTAL_ENTITY_ID_BASE = 27_000_000;

export class LegendsInn {
    private static stagesByLevel: Map<string, LegendsInnStageInfo> = new Map();
    private static portalEntName = 'LegendsInnPortal';
    /** Level scopes whose way onward is open. Cleared when the scope's run is reset. */
    private static openScopes: Set<string> = new Set();
    /** Which of a scope's bosses have died, and which have had their bodies removed. */
    private static defeatedBosses: Map<string, Set<string>> = new Map();
    private static destroyedBosses: Map<string, Set<string>> = new Map();
    private static fallbackTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    /**
     * How long the last boss death waits for the body to be removed before the
     * portal opens anyway. Long enough for any death animation and fade, short
     * enough that a party never wonders whether the run is broken.
     */
    private static readonly BODY_GRACE_MS = 20_000;

    static load(dataDir: string): void {
        LegendsInn.stagesByLevel.clear();
        LegendsInn.openScopes.clear();
        for (const scopeKey of [...LegendsInn.defeatedBosses.keys(), ...LegendsInn.destroyedBosses.keys()]) {
            LegendsInn.clearPendingBossState(scopeKey);
        }

        const filePath = path.join(dataDir, 'legends_inn_stages.json');
        if (!fs.existsSync(filePath)) {
            // The dungeon simply is not built in this checkout; every entry point
            // below is a no-op, and nothing else in the server depends on it.
            console.log('[LegendsInn] legends_inn_stages.json not found; portals disabled.');
            return;
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '')) as {
                portalEnt?: string;
                stages?: LegendsInnStageInfo[];
            };

            LegendsInn.portalEntName = String(parsed.portalEnt ?? LegendsInn.portalEntName);
            for (const stage of parsed.stages ?? []) {
                const levelName = LevelConfig.normalizeLevelName(stage.levelName) || String(stage.levelName ?? '');
                if (!levelName) {
                    continue;
                }
                LegendsInn.stagesByLevel.set(levelName, { ...stage, levelName });
            }
            console.log(`[LegendsInn] Loaded ${LegendsInn.stagesByLevel.size} stages.`);
        } catch (err) {
            console.error('[LegendsInn] Failed to load legends_inn_stages.json:', err);
        }
    }

    static getStage(levelName: string | null | undefined): LegendsInnStageInfo | null {
        const normalized = LevelConfig.normalizeLevelName(levelName) || String(levelName ?? '').trim();
        return LegendsInn.stagesByLevel.get(normalized) ?? null;
    }

    /**
     * The stage a character is up to, 1-based.
     *
     * Legends' Inn is nine dungeons walked in one sitting, which is a long sitting:
     * a disconnect, a crash or a mistaken step back through the entrance used to
     * put the whole run back at stage 1. So the stage a character last stood in is
     * remembered on the character, and the Craft Town portal reads it.
     *
     * Clamped to a stage that actually exists, so a save written when the dungeon
     * was longer - or a hand-edited one - cannot send a player to a level that is
     * not built.
     */
    static getCheckpointStage(character: unknown): number {
        const stages = LegendsInn.getStages().length;
        if (stages === 0) {
            return 1;
        }
        const stored = Math.round(Number((character as Record<string, unknown> | null)?.legendsInnStage ?? 0));
        return Number.isFinite(stored) && stored >= 1 ? Math.min(stored, stages) : 1;
    }

    /** The level a character entering Legends' Inn should land in. */
    static getCheckpointLevelName(character: unknown): string | null {
        const stage = LegendsInn.getStages().find(
            (entry) => Math.round(Number(entry.stage)) === LegendsInn.getCheckpointStage(character)
        );
        return stage?.levelName ?? LegendsInn.getStages()[0]?.levelName ?? null;
    }

    /**
     * Records that a character reached a stage. Returns true if the save moved.
     *
     * Only ever forwards. A party member who walks back through the entrance door
     * of stage 5 and re-enters must not have their checkpoint dragged to stage 1 by
     * the arrival that follows, and a player helping a friend through an earlier
     * stage keeps their own progress.
     */
    static noteStageEntered(client: Client): boolean {
        const stage = LegendsInn.getStage(client?.currentLevel);
        const character = client?.character as Record<string, unknown> | undefined;
        if (!stage || !character) {
            return false;
        }

        const reached = Math.max(1, Math.round(Number(stage.stage) || 1));
        if (LegendsInn.getCheckpointStage(character) >= reached) {
            return false;
        }
        character.legendsInnStage = reached;
        console.log(`[LegendsInn] ${String(character.name ?? '')} checkpoint -> stage ${reached}`);
        return true;
    }

    /**
     * Forgets a character's progress, so the next visit starts at stage 1.
     *
     * Called when the last stage is cleared: the tour is over, and the reward for
     * finishing it is not a permanent shortcut past the other eight.
     */
    static clearCheckpoint(character: unknown): boolean {
        const record = character as Record<string, unknown> | null;
        if (!record || LegendsInn.getCheckpointStage(record) <= 1) {
            return false;
        }
        record.legendsInnStage = 1;
        return true;
    }

    /** True for the stage that ends the dungeon. */
    static isFinalStage(levelName: string | null | undefined): boolean {
        const stage = LegendsInn.getStage(levelName);
        const stages = LegendsInn.getStages();
        return Boolean(stage) && Math.round(Number(stage!.stage)) === stages.length;
    }

    static isStageLevel(levelName: string | null | undefined): boolean {
        return LegendsInn.getStage(levelName) !== null;
    }

    static getStages(): LegendsInnStageInfo[] {
        return [...LegendsInn.stagesByLevel.values()];
    }

    /**
     * How many levels this stage's monsters are lifted by, for `mBonusLevels`.
     *
     * This is the only number that decides how much health a hostile in here
     * actually has. The client sizes a client-spawned hostile in
     * `Entity.method_986` as
     * `HOSTILE_BASE_HP[entType.Level + mBonusLevels] * entType.HitPoints`, and
     * `mBonusLevels` reaches it in the player-data packet. Without it a stage-1
     * mob fights at the level it was authored for - a Dog Packmate at 2,036 hit
     * points - however the level is configured on the server.
     *
     * Zero for every level that is not a Legends' Inn stage, so nothing else in
     * the game changes: the shipped Dread dungeons keep the behaviour they have
     * today rather than silently gaining the jump their config implies.
     */
    static getMonsterBonusLevels(levelName: string | null | undefined): number {
        const stage = LegendsInn.getStage(levelName);
        return stage ? Math.max(0, Math.round(Number(stage.monsterBonusLevels) || 0)) : 0;
    }

    /**
     * The level the dungeon *presents* as, given the bonus its monsters carry.
     *
     * The entry plate reads `mapLevel + mBonusLevels` (class_100), so a stage that
     * lifts its monsters by 40 would announce itself as level 90. Taking the bonus
     * back out here leaves the plate showing the level the dungeon really is.
     *
     * Anchored to the level's own `baseId` rather than to the party level a
     * dungeon normally reports: Legends' Inn is a level-50 dungeon whoever walks
     * in, and its monsters are lifted to 50 regardless, so the plate must not
     * follow the party down.
     */
    static adjustDisplayMapLevel(levelName: string | null | undefined, mapLevel: number): number {
        const bonus = LegendsInn.getMonsterBonusLevels(levelName);
        if (bonus <= 0) {
            return mapLevel;
        }
        return Math.max(1, Math.round(LevelConfig.get(LevelConfig.normalizeLevelName(levelName) || '').baseId) - bonus);
    }

    /** True once this instance's boss is down and the way onward is open. */
    static isPortalOpen(levelScope: string | null | undefined): boolean {
        return LegendsInn.openScopes.has(String(levelScope ?? ''));
    }

    /**
     * Whether a door may be used.
     *
     * Only the *exit* door is gated. The door a stage was entered through stays
     * usable throughout, so a party that bites off more than it can chew is never
     * sealed in - that door leads back to Craft Town, not deeper into the run.
     */
    static isDoorUnlocked(client: Client, doorId: number): boolean {
        const stage = LegendsInn.getStage(client?.currentLevel);
        if (!stage || Math.round(Number(doorId)) !== stage.exitDoorId) {
            return true;
        }
        return LegendsInn.isPortalOpen(getClientLevelScope(client));
    }

    /**
     * The stage boss this entity is, or null.
     *
     * Names are compared the way the rest of the server compares entity names -
     * case- and punctuation-insensitively - because a hostile reaches here having
     * been round-tripped through the client's cue.
     */
    private static matchBoss(stage: LegendsInnStageInfo, entity: unknown): string | null {
        const name = LegendsInn.normalizeName(
            (entity as Record<string, unknown> | null)?.name ??
            (entity as Record<string, unknown> | null)?.EntName ??
            (entity as Record<string, unknown> | null)?.entName
        );
        if (!name) {
            return null;
        }
        return stage.bosses.find((boss) => LegendsInn.normalizeName(boss) === name) ?? null;
    }

    /**
     * A hostile died. Records it, and arms the fallback that opens the way anyway.
     *
     * Death is *not* what opens the portal - see noteEntityDestroyed. But a body
     * that is never destroyed must not seal the run in: the destroy packet is the
     * client's to send, and a client that dies, disconnects or drops the packet
     * would otherwise leave the party in a dungeon with no exit. So the last boss
     * death starts a grace period, and whichever arrives first wins.
     *
     * Every boss the stage lists has to fall, not just one: Bridgetown's twins are
     * two boss cues in one room and the fight is not over until both are down.
     */
    static noteEntityDefeated(client: Client, entity: unknown): void {
        const stage = LegendsInn.getStage(client?.currentLevel);
        const boss = stage ? LegendsInn.matchBoss(stage, entity) : null;
        if (!stage || !boss) {
            return;
        }

        const scopeKey = String(getClientLevelScope(client) ?? '');
        if (!scopeKey || LegendsInn.openScopes.has(scopeKey)) {
            return;
        }

        const defeated = LegendsInn.defeatedBosses.get(scopeKey) ?? new Set<string>();
        defeated.add(boss);
        LegendsInn.defeatedBosses.set(scopeKey, defeated);
        if (defeated.size < stage.bosses.length || LegendsInn.fallbackTimers.has(scopeKey)) {
            return;
        }

        console.log(`[LegendsInn] ${stage.levelName} boss down in ${scopeKey}; waiting for the body`);
        const timer = setTimeout(() => {
            LegendsInn.fallbackTimers.delete(scopeKey);
            console.log(`[LegendsInn] ${stage.levelName} portal opened on the grace period (no destroy seen)`);
            LegendsInn.openPortal(scopeKey, stage);
        }, LegendsInn.BODY_GRACE_MS);
        if (typeof timer.unref === 'function') {
            timer.unref();
        }
        LegendsInn.fallbackTimers.set(scopeKey, timer);
    }

    /**
     * A body was removed from the level. Opens the portal once the boss is gone.
     *
     * This is the signal the dungeon is written around: the client sends it when
     * the death animation has finished playing and the corpse has left the room,
     * so the portal fades in on an empty floor rather than on top of a boss that
     * is still falling over.
     *
     * Only counted for a boss the run has already seen die. A body is also
     * destroyed when it simply leaves a client's view - walking out of the room,
     * unloading the level - and a portal must never open because somebody walked
     * away from a boss that is still alive.
     */
    static noteEntityDestroyed(client: Client, entity: unknown): void {
        const stage = LegendsInn.getStage(client?.currentLevel);
        const boss = stage ? LegendsInn.matchBoss(stage, entity) : null;
        if (!stage || !boss) {
            return;
        }

        const scopeKey = String(getClientLevelScope(client) ?? '');
        if (!scopeKey || LegendsInn.openScopes.has(scopeKey)) {
            return;
        }
        if (!LegendsInn.defeatedBosses.get(scopeKey)?.has(boss)) {
            return;
        }

        const gone = LegendsInn.destroyedBosses.get(scopeKey) ?? new Set<string>();
        gone.add(boss);
        LegendsInn.destroyedBosses.set(scopeKey, gone);
        if (gone.size < stage.bosses.length) {
            return;
        }

        LegendsInn.openPortal(scopeKey, stage);
    }

    /**
     * Opens the way out of a stage for everyone standing in it.
     *
     * Idempotent on the scope, so a boss whose death is reported by several
     * clients - the normal case in a party - spawns one portal, once.
     */
    static openPortal(levelScope: string, stage: LegendsInnStageInfo): void {
        const scopeKey = String(levelScope ?? '');
        if (!scopeKey || LegendsInn.openScopes.has(scopeKey)) {
            return;
        }

        LegendsInn.openScopes.add(scopeKey);
        LegendsInn.clearPendingBossState(scopeKey);
        console.log(`[LegendsInn] ${stage.levelName} portal opened for scope ${scopeKey}`);

        const isFinal = LegendsInn.isFinalStage(stage.levelName);
        for (const session of GlobalState.getSessionsInLevelScope(scopeKey)) {
            LegendsInn.sendPortal(session, stage);
            // The tour is over. Everyone who saw the last boss fall starts the next
            // visit at Wolf's End again - the checkpoint is there to survive a
            // disconnect, not to hand out a permanent shortcut to stage 9.
            if (isFinal && LegendsInn.clearCheckpoint(session.character) && typeof session.scheduleCharacterSave === 'function') {
                session.scheduleCharacterSave("legends' inn run completed");
            }
        }
    }

    /**
     * Hands the portal to one session, if its stage has already been cleared.
     *
     * Called on every arrival, which is what covers the two cases the death
     * broadcast cannot: a party member who was still loading when the boss fell,
     * and a player who disconnects after the kill and comes back to a run that is
     * already open.
     */
    static onPlayerSpawned(client: Client): void {
        const stage = LegendsInn.getStage(client?.currentLevel);
        if (!stage) {
            return;
        }

        // Arrival is what the checkpoint is taken from, not the clear: a player who
        // drops out fighting stage 5's boss comes back to stage 5 rather than to the
        // start of a stage they had already walked.
        if (LegendsInn.noteStageEntered(client) && typeof client.scheduleCharacterSave === 'function') {
            client.scheduleCharacterSave("legends' inn stage checkpoint");
        }

        if (!LegendsInn.isPortalOpen(getClientLevelScope(client))) {
            return;
        }
        LegendsInn.sendPortal(client, stage);
    }

    /**
     * Forgets a scope's progress.
     *
     * A level scope is reused when a fresh run starts in the same instance, and a
     * stage whose portal is remembered from the last run would let the next party
     * walk straight past its boss.
     */
    static resetScope(levelScope: string | null | undefined): void {
        const scopeKey = String(levelScope ?? '');
        LegendsInn.openScopes.delete(scopeKey);
        LegendsInn.clearPendingBossState(scopeKey);
        // The boss chest is part of the same run: a fresh party in a reused
        // instance breaks a fresh chest, and one that stayed claimed would pay
        // nobody. Imported lazily for the same reason sendPortal's import is.
        const { resetChestOpenings } = require('./LegendsInnChest') as typeof import('./LegendsInnChest');
        resetChestOpenings(scopeKey);
    }

    /** Drops a scope's half-finished boss bookkeeping and stops its grace period. */
    private static clearPendingBossState(levelScope: string): void {
        LegendsInn.defeatedBosses.delete(levelScope);
        LegendsInn.destroyedBosses.delete(levelScope);
        const timer = LegendsInn.fallbackTimers.get(levelScope);
        if (timer) {
            clearTimeout(timer);
            LegendsInn.fallbackTimers.delete(levelScope);
        }
    }

    /** Drops every scope of a level. Used when the last player leaves an instance. */
    static resetLevel(levelName: string | null | undefined): void {
        const normalized = LevelConfig.normalizeLevelName(levelName) || String(levelName ?? '').trim();
        if (!normalized) {
            return;
        }
        const scopeKeys = new Set([
            ...LegendsInn.openScopes,
            ...LegendsInn.defeatedBosses.keys(),
            ...LegendsInn.destroyedBosses.keys()
        ]);
        for (const scopeKey of scopeKeys) {
            if (getScopeLevelName(scopeKey) === normalized) {
                LegendsInn.resetScope(scopeKey);
            }
        }
    }

    static getPortalEntityId(stage: LegendsInnStageInfo): number {
        return PORTAL_ENTITY_ID_BASE + Math.max(1, Math.round(Number(stage.stage) || 1));
    }

    static isPortalEntityId(entityId: unknown): boolean {
        const id = Math.round(Number(entityId ?? 0));
        return id > PORTAL_ENTITY_ID_BASE && id <= PORTAL_ENTITY_ID_BASE + 999;
    }

    /**
     * The portal entity.
     *
     * Team 3 - the neutral/NPC team - rather than ENEMY, so nothing targets it
     * and no brain ever picks a fight with it, and `untargetable` on top of that
     * so a stray cleave cannot either. It stands in the ACTIVE state because its
     * EntType's animation is its idle: a SLEEP-state entity is handed its (empty)
     * sleep cue and stops moving, which is the one thing this entity is for.
     */
    static buildPortalEntity(stage: LegendsInnStageInfo): EntityProps & Record<string, unknown> {
        const entityId = LegendsInn.getPortalEntityId(stage);
        return {
            id: entityId,
            name: LegendsInn.portalEntName,
            isPlayer: false,
            x: stage.portal.x,
            y: stage.portal.y,
            spawnX: stage.portal.x,
            spawnY: stage.portal.y,
            spawnEntState: EntityState.ACTIVE,
            v: 0,
            team: EntityTeam.NPC,
            renderDepthOffset: 0,
            characterName: '',
            dramaAnim: '',
            sleepAnim: '',
            summonerId: 0,
            powerId: 0,
            entState: EntityState.ACTIVE,
            facingLeft: false,
            running: false,
            jumping: false,
            dropping: false,
            backpedal: false,
            untargetable: true,
            healthDelta: 0,
            buffs: [],
            roomId: -1,
            // Server-owned: neither a client spawn nor a session's own entity, so
            // the ownership sweeps that follow players between scopes leave it be.
            clientSpawned: false,
            legendsInnPortal: true
        };
    }

    private static sendPortal(client: Client, stage: LegendsInnStageInfo): void {
        if (!client?.playerSpawned) {
            return;
        }

        const entityId = LegendsInn.getPortalEntityId(stage);
        if (client.knownEntityIds.has(entityId)) {
            return;
        }

        const props = LegendsInn.buildPortalEntity(stage);
        client.entities.set(entityId, { ...props });
        // Imported lazily: EntityHandler pulls in most of the handler layer, and
        // this module is loaded by LevelConfig-time bootstrap.
        const { EntityHandler } = require('../handlers/EntityHandler') as typeof import('../handlers/EntityHandler');
        EntityHandler.sendEntity(client, props);
    }

    private static normalizeName(value: unknown): string {
        return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    }
}
